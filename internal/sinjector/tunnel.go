package sinjector

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
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
		p.handleHTTP(ctx, clientBuf, host, "http")
	default:
		relay(clientBuf, upstream)
	}
}

// handleTLS terminates TLS from the client with a dynamically-generated
// certificate, then re-encrypts to the upstream. After decryption, it peeks
// again to decide between HTTP inspection and raw passthrough.
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
		_ = tlsUpstream.Close()
		p.handleHTTP(ctx, tlsClientBuf, host, "https")
		return
	}

	relay(tlsClientBuf, tlsUpstream)
}

// handleHTTP parses HTTP/1.1 requests from client, injects secrets into
// headers, path, and query params, forwards to upstream, then relays the
// response back.
func (p *proxy) handleHTTP(ctx context.Context, client net.Conn, target, scheme string) {
	clientBr := bufio.NewReader(client)

	for {
		req, err := http.ReadRequest(clientBr)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				slog.DebugContext(ctx, "read request failed", slog.Any("err", err))
			}
			return
		}

		req = rewriteRequest(req.WithContext(ctx), p.resolver, target)
		upstreamReq := upstreamRequest(req, target, scheme)

		resp, err := p.transport.RoundTrip(upstreamReq)
		if err != nil {
			slog.DebugContext(ctx, "round trip failed", slog.Any("err", err))
			return
		}

		if resp.StatusCode == http.StatusSwitchingProtocols {
			writeErr := writeResponse(client, resp, true)
			_ = resp.Body.Close()
			if writeErr != nil {
				return
			}
			return
		}

		writeErr := writeResponse(client, resp, false)
		_ = resp.Body.Close()
		if writeErr != nil {
			return
		}

		if req.Close || resp.Close || upstreamReq.Close {
			return
		}
	}
}

// writeResponse streams an HTTP/1.1 response to dst without the buffered
// serialization used by net/http, which can coalesce small chunks and hurt
// token-by-token streaming behavior.
func writeResponse(dst net.Conn, resp *http.Response, closeConn bool) error {
	if err := writeResponseHead(dst, resp, closeConn); err != nil {
		return err
	}
	if resp.Body == nil || !bodyAllowed(resp.StatusCode) {
		return nil
	}
	chunked := resp.ContentLength < 0 && resp.Body != nil && bodyAllowed(resp.StatusCode)
	if chunked {
		return writeChunkedBody(dst, resp.Body)
	}
	_, err := io.Copy(dst, resp.Body)
	return err
}

// writeResponseHead writes the HTTP/1.1 response line and headers to dst.
func writeResponseHead(dst net.Conn, resp *http.Response, closeConn bool) error {
	if _, err := fmt.Fprintf(dst, "HTTP/1.1 %s\r\n", resp.Status); err != nil {
		return err
	}

	header := resp.Header.Clone()
	chunked := resp.ContentLength < 0 && resp.Body != nil && bodyAllowed(resp.StatusCode)
	if chunked {
		header.Del("Content-Length")
		header.Set("Transfer-Encoding", "chunked")
	}
	if !chunked {
		header.Del("Transfer-Encoding")
	}
	if resp.Close || closeConn {
		header.Set("Connection", "close")
	}

	if err := header.Write(dst); err != nil {
		return err
	}
	if _, err := io.WriteString(dst, "\r\n"); err != nil {
		return err
	}
	return nil
}

// writeChunkedBody preserves streaming semantics by emitting chunk frames as
// each upstream read completes instead of buffering behind a bufio.Writer.
func writeChunkedBody(dst net.Conn, body io.Reader) error {
	buf := make([]byte, 32*1024)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := fmt.Fprintf(dst, "%x\r\n", n); werr != nil {
				return werr
			}
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			if _, werr := io.WriteString(dst, "\r\n"); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) {
			_, werr := io.WriteString(dst, "0\r\n\r\n")
			return werr
		}
		if err != nil {
			return err
		}
	}
}

// bodyAllowed reports whether the response status permits a message body.
func bodyAllowed(status int) bool {
	if status >= 100 && status < 200 {
		return false
	}
	return status != http.StatusNoContent && status != http.StatusNotModified
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

// upstreamRequest converts an inbound proxy request into a client request
// suitable for RoundTrip while preserving the rewritten request body.
func upstreamRequest(req *http.Request, target, scheme string) *http.Request {
	out := req.Clone(req.Context())
	if out.URL == nil {
		out.URL = &url.URL{}
	} else {
		clonedURL := *out.URL
		out.URL = &clonedURL
	}
	out.URL.Scheme = scheme
	out.URL.Host = target
	if out.Host == "" {
		out.Host = target
	}
	out.RequestURI = ""
	out.Close = req.Close
	out.Header = cloneHeaderWithoutHopByHop(req.Header)
	return out
}

// cloneHeaderWithoutHopByHop removes hop-by-hop headers before upstream proxying.
func cloneHeaderWithoutHopByHop(in http.Header) http.Header {
	out := in.Clone()
	for _, key := range hopByHopHeaders(out) {
		out.Del(key)
	}
	out.Del("Proxy-Connection")
	return out
}

// hopByHopHeaders returns hop-by-hop headers named directly or via Connection.
func hopByHopHeaders(header http.Header) []string {
	keys := []string{
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Te",
		"Trailer",
		"Transfer-Encoding",
		"Upgrade",
	}
	connection := header.Values("Connection")
	for _, value := range connection {
		for item := range strings.SplitSeq(value, ",") {
			item = textproto.TrimString(item)
			if item == "" {
				continue
			}
			keys = append(keys, item)
		}
	}
	return keys
}
