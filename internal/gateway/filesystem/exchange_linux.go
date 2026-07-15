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

func exchangeFiles(root *os.Root, first, second string) (bool, error) {
	dirName := path.Dir(first)
	if dirName != path.Dir(second) {
		return false, errors.New("exchange files in different directories")
	}

	dir, err := root.Open(dirName)
	if err != nil {
		return false, fmt.Errorf("open exchange directory: %w", err)
	}
	exchangeErr := unix.Renameat2(
		int(dir.Fd()),
		path.Base(first),
		int(dir.Fd()),
		path.Base(second),
		unix.RENAME_EXCHANGE,
	)
	closeErr := dir.Close()
	if closeErr != nil {
		return false, fmt.Errorf("close exchange directory: %w", closeErr)
	}
	if exchangeErr == nil {
		return true, nil
	}
	// FUSE filesystems may report EINVAL for unsupported rename flags.
	unsupported := errors.Is(exchangeErr, unix.EINVAL) || errors.Is(exchangeErr, unix.ENOSYS) || errors.Is(exchangeErr, unix.EOPNOTSUPP)
	if unsupported {
		return false, nil
	}
	return false, fmt.Errorf("exchange files: %w", exchangeErr)
}
