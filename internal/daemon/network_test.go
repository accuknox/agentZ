package daemon

import (
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/miekg/dns"

	"github.com/accuknox/agentz/internal/sandboxutil"
)

type blockedDNSWriter struct {
	dns.ResponseWriter
	entered chan struct{}
	release chan struct{}
}

func (w *blockedDNSWriter) WriteMsg(*dns.Msg) error {
	close(w.entered)
	<-w.release
	return nil
}

type dnsMatchCase struct {
	name  string
	allow bool
}

func TestNativeDNSPreservesSandboxWildcardSemantics(t *testing.T) {
	t.Parallel()
	hosts, err := sandboxutil.ParseHostList([]string{"exact.example", "*.single.example", "**.deep.example", "10.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []dnsMatchCase{
		{"EXACT.EXAMPLE.", true}, {"child.exact.example.", false},
		{"one.single.example.", true}, {"two.one.single.example.", false}, {"single.example.", false},
		{"one.deep.example.", true}, {"two.one.deep.example.", true}, {"deep.example.", false},
		{"notexact.example.", false}, {"example.org.", false},
	} {
		if actual := allowedDNS(hosts, tc.name); actual != tc.allow {
			t.Errorf("allowedDNS(%q) = %v, want %v", tc.name, actual, tc.allow)
		}
	}
}

func TestDNSAddressesDoNotTrustUnrelatedAnswers(t *testing.T) {
	t.Parallel()
	answers := []dns.RR{
		&dns.A{Hdr: dns.RR_Header{Name: "unrelated.example.", Rrtype: dns.TypeA, Ttl: 600}, A: net.ParseIP("192.0.2.9")},
		&dns.A{Hdr: dns.RR_Header{Name: "cdn.example.", Rrtype: dns.TypeA, Ttl: 600}, A: net.ParseIP("192.0.2.1")},
		&dns.CNAME{Hdr: dns.RR_Header{Name: "allowed.example.", Rrtype: dns.TypeCNAME, Ttl: 30}, Target: "cdn.example."},
		&dns.AAAA{Hdr: dns.RR_Header{Name: "cdn.example.", Rrtype: dns.TypeAAAA, Ttl: 20}, AAAA: net.ParseIP("2001:db8::1")},
	}
	actual := dnsAddresses("ALLOWED.EXAMPLE.", answers)
	if len(actual) != 2 || actual[netip.MustParseAddr("192.0.2.1")] != 30 || actual[netip.MustParseAddr("2001:db8::1")] != 20 {
		t.Fatalf("CNAME address/TTL authorization = %#v", actual)
	}
}

func TestNativeNFTTransactionInIsolatedNamespace(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("isolated nftables validation requires root")
	}
	for _, tool := range []string{"unshare", "nft"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s unavailable: %v", tool, err)
		}
	}
	probe := exec.CommandContext(t.Context(), "unshare", "--net", "true")
	if output, err := probe.CombinedOutput(); err != nil {
		t.Skipf("network namespace capability unavailable: %v: %s", err, output)
	}
	hosts, err := sandboxutil.ParseHostList([]string{"192.0.2.0/24", "2001:db8::/32", "*.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	// A fresh private namespace is destroyed when nft exits. No host network
	// configuration, filesystem mounts or system services are changed.
	script := nativeRules(hosts) + nativeRules(hosts) + `
add element inet agentz_native dns4 { 192.0.2.1 timeout 30s }
add element inet agentz_native dns4 { 192.0.2.1 timeout 60s }
delete element inet agentz_native dns4 { 192.0.2.1 }
add element inet agentz_native dns4 { 192.0.2.1 timeout 60s }
`
	command := exec.CommandContext(t.Context(), "unshare", "--net", "nft", "-f", "-")
	command.Stdin = strings.NewReader(script)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("nft policy/replacement/TTL transaction rejected: %v: %s", err, output)
	}
}

// TestNativeNetworkPackets runs the production adapter inside private mount and
// network namespaces. Neither /etc, /run nor host sysctls can escape the child.
func TestNativeNetworkPackets(t *testing.T) {
	if os.Getenv("AGENTZ_NETWORK_ISOLATED_TEST") != "1" {
		if os.Geteuid() != 0 {
			t.Skip("packet integration requires namespace capabilities")
		}
		for _, name := range []string{"unshare", "ip", "nft"} {
			if _, err := exec.LookPath(name); err != nil {
				t.Skipf("%s unavailable", name)
			}
		}
		probe := exec.CommandContext(t.Context(), "unshare", "--net", "--mount", "true")
		if output, err := probe.CombinedOutput(); err != nil {
			t.Skipf("namespace capabilities unavailable: %v: %s", err, output)
		}
		binary, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		command := exec.CommandContext(t.Context(), "unshare", "--net", "--mount", "--propagation", "private", binary, "-test.run=^TestNativeNetworkPackets$", "-test.v")
		command.Env = append(os.Environ(), "AGENTZ_NETWORK_ISOLATED_TEST=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("isolated native packet test: %v\n%s", err, output)
		} else {
			t.Log(string(output))
		}
		return
	}
	for _, target := range []string{"/run", "/etc"} {
		if err := unix.Mount("tmpfs", target, "tmpfs", 0, "mode=0755"); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile("/etc/resolv.conf", []byte("nameserver 127.0.0.1\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"link", "set", "lo", "up"},
		{"address", "add", "198.18.0.1/32", "dev", "lo"},
		{"address", "add", "198.18.0.2/32", "dev", "lo"},
		{"address", "add", "198.18.0.3/32", "dev", "lo"},
		{"-6", "address", "add", "fd42::1/128", "dev", "lo", "nodad"},
	} {
		if err := networkCommand(t.Context(), "", "ip", args...); err != nil {
			t.Fatal(err)
		}
	}
	resolver, err := net.ListenPacket("udp4", "127.0.0.1:53")
	if err != nil {
		t.Fatal(err)
	}
	upstream := &dns.Server{PacketConn: resolver, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, request *dns.Msg) {
		answer := new(dns.Msg)
		answer.SetReply(request)
		answer.Answer = []dns.RR{&dns.A{
			Hdr: dns.RR_Header{Name: request.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 1},
			A:   net.ParseIP("198.18.0.1"),
		}}
		if request.Question[0].Name == "malformed.test." {
			answer.Answer = []dns.RR{&dns.A{
				Hdr: dns.RR_Header{Name: "malformed.test.", Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60},
				A:   net.ParseIP("198.18.0.3"),
			}}
			packet, err := answer.Pack()
			if err != nil {
				t.Error(err)
				return
			}
			// A truncated additional record leaves a decoded answer alongside
			// an error. That answer must never authorize network access.
			packet[11]++
			packet = append(packet, 0xc0)
			var partial dns.Msg
			if err := partial.Unpack(packet); err == nil || len(partial.Answer) != 1 {
				t.Error("malformed fixture must yield a partial answer and an error")
				return
			}
			_, _ = w.Write(packet)
			return
		}
		_ = w.WriteMsg(answer)
	})}
	go upstream.ActivateAndServe()
	defer upstream.Shutdown()
	n, err := NewNetwork(t.Context(), []string{"allowed.test", "malformed.test", "198.18.0.2/32", "fd42::1/128"})
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	tcp, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcp.Close()
	go func() {
		for {
			connection, err := tcp.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				_ = connection.SetDeadline(time.Now().Add(time.Second))
				_, _ = io.Copy(connection, connection)
			}()
		}
	}()
	udp, err := net.ListenPacket("udp4", "198.18.0.2:0")
	if err != nil {
		t.Fatal(err)
	}
	_, udpPort, _ := net.SplitHostPort(udp.LocalAddr().String())
	otherUDP, err := net.ListenPacket("udp4", net.JoinHostPort("198.18.0.3", udpPort))
	if err != nil {
		t.Fatal(err)
	}
	for _, socket := range []net.PacketConn{udp, otherUDP} {
		defer socket.Close()
		go func() {
			var buffer [64]byte
			for {
				n, peer, err := socket.ReadFrom(buffer[:])
				if err != nil {
					return
				}
				_, _ = socket.WriteTo(buffer[:n], peer)
			}
		}()
	}
	_, tcpPort, _ := net.SplitHostPort(tcp.Addr().String())
	probe := func(network, address string, allowed bool) {
		t.Helper()
		err := inNamespace(func() error {
			connection, err := net.DialTimeout(network, address, 250*time.Millisecond)
			if err != nil {
				return err
			}
			defer connection.Close()
			_ = connection.SetDeadline(time.Now().Add(250 * time.Millisecond))
			if _, err := connection.Write([]byte("hello")); err != nil {
				return err
			}
			var data [5]byte
			_, err = io.ReadFull(connection, data[:])
			return err
		})
		if (err == nil) != allowed {
			t.Fatalf("%s %s allowed=%v: %v", network, address, allowed, err)
		}
	}
	probe("tcp4", net.JoinHostPort("198.18.0.1", tcpPort), false)
	probe("tcp4", net.JoinHostPort("198.18.0.2", tcpPort), true)
	probe("udp4", net.JoinHostPort("198.18.0.2", udpPort), true)
	probe("udp4", net.JoinHostPort("198.18.0.3", udpPort), false)
	probe("tcp6", net.JoinHostPort("fd42::1", tcpPort), true)
	for _, question := range []string{"denied.test.", "malformed.test.", "allowed.test."} {
		var answer *dns.Msg
		err := inNamespace(func() error {
			request := new(dns.Msg)
			request.SetQuestion(question, dns.TypeA)
			var err error
			answer, _, err = (&dns.Client{Timeout: time.Second}).Exchange(request, "127.0.0.53:53")
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		if question == "denied.test." && answer.Rcode != dns.RcodeRefused {
			t.Fatal("unauthorized DNS query was forwarded")
		}
		if question == "malformed.test." && answer.Rcode != dns.RcodeServerFailure {
			t.Fatal("malformed upstream answer was accepted")
		}
		if question == "allowed.test." && answer.Rcode != dns.RcodeSuccess {
			t.Fatalf("authorized DNS query failed: %s", answer)
		}
	}
	if err := inNamespace(func() error {
		request := new(dns.Msg)
		request.SetQuestion("allowed.test.", dns.TypeA)
		answer, _, err := (&dns.Client{Net: "tcp", Timeout: time.Second}).Exchange(request, "127.0.0.53:53")
		if err != nil {
			return err
		}
		if answer.Rcode != dns.RcodeSuccess {
			return fmt.Errorf("DNS over TCP returned %d", answer.Rcode)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	probe("tcp4", net.JoinHostPort("198.18.0.3", tcpPort), false)
	probe("tcp4", net.JoinHostPort("198.18.0.1", tcpPort), true)
	time.Sleep(1200 * time.Millisecond)
	probe("tcp4", net.JoinHostPort("198.18.0.1", tcpPort), false)
	if err := n.Update(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	probe("tcp4", net.JoinHostPort("198.18.0.2", tcpPort), false)

	// A client that stops reading must not delay revoking its DNS-granted access.
	if err := n.Update(t.Context(), []string{"allowed.test"}); err != nil {
		t.Fatal(err)
	}
	writer := &blockedDNSWriter{entered: make(chan struct{}), release: make(chan struct{})}
	finished := make(chan struct{})
	defer func() { close(writer.release); <-finished }()
	request := new(dns.Msg)
	request.SetQuestion("allowed.test.", dns.TypeA)
	go func() { n.serveDNS(writer, request); close(finished) }()
	select {
	case <-writer.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("DNS request did not reach the client")
	}
	updated := make(chan error, 1)
	go func() { updated <- n.Update(t.Context(), nil) }()
	select {
	case err := <-updated:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("slow DNS client blocked policy revocation")
	}
	probe("tcp4", net.JoinHostPort("198.18.0.1", tcpPort), false)
}
