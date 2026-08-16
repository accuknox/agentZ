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

// Package v1alpha1 contains API Schema definitions for the agentz v1alpha1 API group.
// +kubebuilder:object:generate=true
// +groupName=agentz.accuknox.com
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var (
	// SchemeGroupVersion is group version used to register these objects.
	// This name is used by applyconfiguration generators (e.g. controller-gen).
	SchemeGroupVersion = schema.GroupVersion{Group: "agentz.accuknox.com", Version: "v1alpha1"}

	// SchemeBuilder is used to add go types to the GroupVersionKind scheme.
	SchemeBuilder = &schemeBuilder{GroupVersion: SchemeGroupVersion}

	// AddToScheme adds the types in this group-version to the given scheme.
	AddToScheme = SchemeBuilder.schemeBuilder().AddToScheme
)

// schemeBuilder wraps runtime.SchemeBuilder for kind registration.
type schemeBuilder struct {
	GroupVersion schema.GroupVersion
	runtime.SchemeBuilder
}

// Register adds objects to the group-version scheme.
func (b *schemeBuilder) Register(objs ...runtime.Object) error {
	b.SchemeBuilder = append(b.SchemeBuilder, func(s *runtime.Scheme) error {
		s.AddKnownTypes(b.GroupVersion, objs...)
		metav1.AddToGroupVersion(s, b.GroupVersion)
		return nil
	})
	return nil
}

func (b *schemeBuilder) schemeBuilder() *runtime.SchemeBuilder {
	return &b.SchemeBuilder
}

// Resource returns a GroupResource for an unqualified resource.
func Resource(resource string) schema.GroupResource {
	return SchemeGroupVersion.WithResource(resource).GroupResource()
}
