package sinjector

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
)

// readBufferedConn wraps a net.Conn so that reads come from a buffered reader
// first, then fall through to the underlying connection. This is necessary when
// peeking bytes to decide which protocol handler to use — the peeked bytes must
// still be available to the handler.
type readBufferedConn struct {
	net.Conn
	r io.Reader
}

func (c *readBufferedConn) Read(p []byte) (int, error) {
	return c.r.Read(p)
}

// handleConnect hijacks the client connection, dials the upstream, sends the
// HTTP 200, then peeks the first bytes to decide between MITM, HTTP parsing,
// or raw passthrough.
func (p *proxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}

	client, _, err := hijacker.Hijack()
	if err != nil {
		slog.ErrorContext(ctx, "hijack failed", slog.Any("err", err))
		return
	}
	defer client.Close()

	host := r.Host
	if !strings.Contains(host, ":") {
		host += ":443"
	}

	upstream, err := net.Dial("tcp", host)
	if err != nil {
		slog.ErrorContext(ctx, "dial upstream failed", slog.Any("err", err))
		_, _ = client.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
		return
	}
	defer upstream.Close()

	if _, err := client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		return
	}

	br := bufio.NewReader(client)
	peek, err := br.Peek(8)
	if err != nil {
		relay(&readBufferedConn{Conn: client, r: br}, upstream)
		return
	}

	clientBuf := &readBufferedConn{Conn: client, r: br}

	switch {
	case looksLikeTLS(peek):
		p.handleTLS(ctx, clientBuf, upstream, host)
	case looksLikeHTTP2(peek):
		relay(clientBuf, upstream)
	case looksLikeHTTP(peek):
		p.handleHTTP(ctx, clientBuf, upstream)
	default:
		relay(clientBuf, upstream)
	}
}

// handleTLS terminates TLS from the client with a dynamically-generated
// certificate, then re-encrypts to the upstream. After decryption, it peeks
// again to decide between HTTP/1.1 inspection and raw passthrough.
func (p *proxy) handleTLS(ctx context.Context, client net.Conn, upstream net.Conn, host string) {
	tlsConfig, err := mitmServerConfig(stripPort(host), p.ca, p.certCache)
	if err != nil {
		slog.ErrorContext(ctx, "mitm tls config failed", slog.Any("err", err))
		return
	}

	tlsClient := tls.Server(client, tlsConfig)
	if err := tlsClient.HandshakeContext(ctx); err != nil {
		slog.DebugContext(ctx, "tls client handshake failed", slog.Any("err", err))
		return
	}
	defer tlsClient.Close()

	upstreamHost := stripPort(host)
	tlsUpstream := tls.Client(upstream, upstreamTLSConfig(upstreamHost))
	if err := tlsUpstream.HandshakeContext(ctx); err != nil {
		slog.DebugContext(ctx, "tls upstream handshake failed", slog.Any("err", err))
		return
	}
	defer tlsUpstream.Close()

	tlsBr := bufio.NewReader(tlsClient)
	tlsPeek, err := tlsBr.Peek(8)
	if err != nil {
		relay(&readBufferedConn{Conn: tlsClient, r: tlsBr}, tlsUpstream)
		return
	}

	tlsClientBuf := &readBufferedConn{Conn: tlsClient, r: tlsBr}

	if looksLikeHTTP(tlsPeek) {
		p.handleHTTP(ctx, tlsClientBuf, tlsUpstream)
		return
	}

	relay(tlsClientBuf, tlsUpstream)
}

// handleHTTP parses HTTP/1.1 requests from client, injects secrets into
// headers, path, and query params, forwards to upstream, then relays the
// response back. On 101 Switching Protocols or HTTP/2 preface, it falls back
// to raw bidirectional copy.
func (p *proxy) handleHTTP(ctx context.Context, client net.Conn, upstream net.Conn) {
	clientBr := bufio.NewReader(client)
	upstreamBr := bufio.NewReader(upstream)

	for {
		req, err := http.ReadRequest(clientBr)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				slog.DebugContext(ctx, "read request failed", slog.Any("err", err))
			}
			return
		}

		req = rewriteRequest(req.WithContext(ctx), p.resolver)

		if err := req.Write(upstream); err != nil {
			slog.DebugContext(ctx, "write request failed", slog.Any("err", err))
			return
		}

		resp, err := http.ReadResponse(upstreamBr, req)
		if err != nil {
			slog.DebugContext(ctx, "read response failed", slog.Any("err", err))
			return
		}

		if resp.StatusCode == http.StatusSwitchingProtocols {
			_ = resp.Body.Close()
			resp.Body = nil
			if err := resp.Write(client); err != nil {
				return
			}
			clientRelay := &readBufferedConn{Conn: client, r: clientBr}
			upstreamRelay := &readBufferedConn{Conn: upstream, r: upstreamBr}
			relay(clientRelay, upstreamRelay)
			return
		}

		writeErr := resp.Write(client)
		_ = resp.Body.Close()
		if writeErr != nil {
			return
		}

		if req.Close || resp.Close {
			return
		}
	}
}

// relay copies bytes bidirectionally between a and b, then closes both.
func relay(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Go(func() {
		_, _ = io.Copy(a, b)
		_ = a.Close()
	})
	wg.Go(func() {
		_, _ = io.Copy(b, a)
		_ = b.Close()
	})
	wg.Wait()
}

// looksLikeTLS reports whether the first bytes look like a TLS handshake.
func looksLikeTLS(peek []byte) bool {
	if len(peek) < 3 {
		return false
	}
	if peek[0] != 0x16 {
		return false
	}
	if peek[1] != 0x03 {
		return false
	}
	return peek[2] <= 0x04
}

// looksLikeHTTP2 reports whether the first bytes look like the HTTP/2
// connection preface ("PRI").
func looksLikeHTTP2(peek []byte) bool {
	return len(peek) >= 3 && string(peek[:3]) == "PRI"
}

// looksLikeHTTP reports whether the first bytes look like an HTTP/1.1
// request.
func looksLikeHTTP(peek []byte) bool {
	methods := []string{
		"GET ",
		"HEAD ",
		"POST ",
		"PUT ",
		"DELETE ",
		"PATCH ",
		"OPTIONS ",
		"TRACE ",
		"CONNECT ",
	}
	for _, m := range methods {
		if len(peek) >= len(m) && string(peek[:len(m)]) == m {
			return true
		}
	}
	return false
}
