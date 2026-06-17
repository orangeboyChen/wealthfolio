# Patched Docker Image

[English](./README.md) | [中文](./README.zh.md)

## What this repository solves

This fork keeps only the GitHub Action needed to build a patched Docker image from upstream Wealthfolio.

The upstream image needs a local patch for runtime connect configuration. This repository only keeps the minimal files required to build and publish that patched image.

## Trigger

Runs automatically every day at 02:40 Asia/Shanghai.
