# Justfile for Git plugin

default:
  @just --list

install:
  npm install

lint:
  npm run lint

test:
  npm test

dist:
  npm run dist
