set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
host := `rustc -vV | sed -n 's/^host: //p'`

default:
  @just --list

fix:
  cargo fmt --all
  cargo clippy --fix --all-targets --all-features --allow-dirty --allow-staged --target {{host}}
