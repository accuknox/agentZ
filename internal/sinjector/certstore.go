package sinjector

import (
	"container/list"
	"crypto/tls"
	"sync"
)

type certStore struct {
	mu    sync.Mutex
	limit int
	items map[string]*list.Element
	order *list.List
}

type certEntry struct {
	host string
	cert *tls.Certificate
}

func newCertStore(limit int) *certStore {
	return &certStore{
		limit: limit,
		items: make(map[string]*list.Element),
		order: list.New(),
	}
}

func (s *certStore) Get(hostname string, gen func() (*tls.Certificate, error)) (*tls.Certificate, error) {
	s.mu.Lock()
	if elem, ok := s.items[hostname]; ok {
		s.order.MoveToFront(elem)
		entry := elem.Value.(certEntry)
		s.mu.Unlock()
		return entry.cert, nil
	}
	s.mu.Unlock()

	cert, err := gen()
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if elem, ok := s.items[hostname]; ok {
		s.order.MoveToFront(elem)
		entry := elem.Value.(certEntry)
		return entry.cert, nil
	}
	elem := s.order.PushFront(certEntry{host: hostname, cert: cert})
	s.items[hostname] = elem
	for s.limit > 0 && s.order.Len() > s.limit {
		back := s.order.Back()
		if back == nil {
			break
		}
		entry := back.Value.(certEntry)
		delete(s.items, entry.host)
		s.order.Remove(back)
	}
	return cert, nil
}
