//go:build linux

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

package filesystem

import (
	"errors"
	"fmt"
	"os"
	"path"

	"golang.org/x/sys/unix"
)

func exchangeFiles(root *os.Root, first, second string) error {
	dirName := path.Dir(first)
	if dirName != path.Dir(second) {
		return errors.New("exchange files in different directories")
	}

	dir, err := root.Open(dirName)
	if err != nil {
		return fmt.Errorf("open exchange directory: %w", err)
	}
	exchangeErr := unix.Renameat2(
		int(dir.Fd()),
		path.Base(first),
		int(dir.Fd()),
		path.Base(second),
		unix.RENAME_EXCHANGE,
	)
	closeErr := dir.Close()
	err = errors.Join(exchangeErr, closeErr)
	if err != nil {
		return fmt.Errorf("exchange files: %w", err)
	}
	return nil
}
