package authorization

import (
	"errors"

	"github.com/golang-jwt/jwt/v5"
)

// DelegationLabel identifies controller-owned OAuth resource routes.
const DelegationLabel = "agentz.accuknox.com/delegation"

// DelegationClaims binds an OAuth access token to its immutable AgentZ grant.
type DelegationClaims struct {
	jwt.RegisteredClaims
	ClientID  string `json:"azp"`
	GrantID   string `json:"agentz_grant_id"`
	Scope     string `json:"scope"`
	SessionID string `json:"sid"`
}

// VerifyDelegationToken checks the access-token contract before live authorization.
func VerifyDelegationToken(bearer, issuer, audience string, key jwt.Keyfunc) (DelegationClaims, error) {
	claims := DelegationClaims{}
	token, err := jwt.ParseWithClaims(bearer, &claims, key,
		jwt.WithValidMethods([]string{"ES256", "RS256"}), jwt.WithIssuer(issuer),
		jwt.WithAudience(audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithStrictDecoding(),
	)
	if err != nil {
		return claims, err
	}
	missingIdentity := claims.GrantID == "" || claims.ClientID == "" || claims.Subject == ""
	if token.Header["typ"] != "at+jwt" || missingIdentity || claims.IssuedAt == nil {
		return claims, errors.New("invalid delegated access token")
	}
	return claims, nil
}
