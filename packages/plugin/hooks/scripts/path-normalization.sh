#!/usr/bin/env bash

# 論理・物理どちらの project root を含むパスも相対化する
project_relative_path() {
  local file_path="$1"
  local logical_root
  local physical_root

  logical_root="$(pwd -L)"
  physical_root="$(pwd -P)"

  case "$file_path" in
    "$logical_root"/*) printf '%s\n' "${file_path#"$logical_root"/}" ;;
    "$physical_root"/*) printf '%s\n' "${file_path#"$physical_root"/}" ;;
    /*) return 1 ;;
    *) printf '%s\n' "$file_path" ;;
  esac
}
