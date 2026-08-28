# Apk（线下主控端，骨架阶段）

Kotlin + Jetpack Compose 最小工程。本地优先：离线可用，本地 JSON 持久化是主数据。

## 打开方式

1. 用 Android Studio 打开本目录（`progress_clocks/Apk`）
2. 无 gradle wrapper，AS 会用本地 Gradle 或提示配置（Settings > Build Tools > Gradle）
3. 首次同步会下载依赖（AGP 8.7.3 / Kotlin 2.0.21 / Compose BOM 2024.12.01）

> 如遇版本报错，按 AS 提示升级 AGP / Kotlin 或调低 compileSdk。

## 环境要求

- minSdk 34（Android 14+，2025 年新手机无兼容负担）
- targetSdk / compileSdk 35

## 规划（设计确认后实现）

- 进度钟列表：网格布局（同屏可见所有钟）、点击 +1、长按菜单（+2/+3/清零/改名/删除）
- 撤销/重做：快照栈（全量，50-100 条），顶栏按钮
- 新建：底部 FAB
- 本地持久化：状态 JSON 存 app 内部存储；变更事件模型为未来同步预留
- 数据模型与 `../Web/src/types.ts` 保持同一契约（camelCase 字段名）

## 目录结构

```
Apk/
  settings.gradle.kts / build.gradle.kts / gradle.properties
  gradle/libs.versions.toml
  app/
    build.gradle.kts
    src/main/
      AndroidManifest.xml
      java/com/progressclocks/app/MainActivity.kt
      res/values/strings.xml, themes.xml
```
