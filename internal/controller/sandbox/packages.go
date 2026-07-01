/*
Copyright 2026 AccuKnox Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package sandbox

import (
	"slices"
	"strings"
)

// DefaultPackages are always present in every Sandbox package list.
var DefaultPackages = []string{
	"gnused",
	"gawk",
	"gnugrep",
	"bc",
	"jq",
	"yq-go",
	"curl",
	"mcporter",
}

func defaultPackages(names []string) []string {
	pkgs := make([]string, 0, len(names)+len(DefaultPackages))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		pkgs = append(pkgs, name)
	}
	pkgs = append(pkgs, DefaultPackages...)
	slices.Sort(pkgs)
	return slices.Compact(pkgs)
}

// DefaultPackagesForWebhook applies the controller package defaults during admission.
func DefaultPackagesForWebhook(names []string) []string {
	return defaultPackages(names)
}
