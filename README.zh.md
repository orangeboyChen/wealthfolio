# Patched Docker Image

[English](./README.md) | [中文](./README.zh.md)

## 这个仓库解决什么问题

这个 fork 只保留用于构建 patched Docker 镜像的 GitHub Action。

上游镜像需要一个本地补丁来支持运行时 connect 配置。这个仓库只保留构建和发布该镜像所需的最小文件集合。

## 触发

每天自动触发，时间是 Asia/Shanghai 02:40。
