#!/bin/sh
set -eu
httpd_source_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$httpd_source_root/scripts/httpd.mjs" deploy "$@"
