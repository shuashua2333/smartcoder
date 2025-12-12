# 📦 JDK 安装说明

## ⚠️ 重要提示

**VS Code 扩展开发通常不需要 JDK！**

如果你看到 VS Code 提示需要 JDK，可能是以下原因：
1. 你安装了某些需要 Java 的扩展（如 Java 开发扩展）
2. VS Code 的某些功能误判
3. 测试框架需要（但你的项目使用 `vscode-test`，不需要 Java）

## 🔍 检查是否真的需要 JDK

### 方法 1: 忽略提示，直接测试

先尝试直接按 `F5` 启动扩展，如果能够正常运行，说明不需要 JDK。

### 方法 2: 检查错误信息

查看 VS Code 的输出面板（`Ctrl+Shift+U`），看看具体是什么功能需要 JDK。

## ✅ 如果真的需要 JDK（通常不需要）

### Windows 安装步骤

1. **下载 JDK**
   - 访问：https://adoptium.net/ 或 https://www.oracle.com/java/technologies/downloads/
   - 下载 JDK 17 或更高版本（推荐 Adoptium Temurin）
   - 选择 Windows x64 版本

2. **安装 JDK**
   - 运行下载的安装程序
   - 安装到默认路径（通常是 `C:\Program Files\Eclipse Adoptium\jdk-17.x.x-hotspot`）

3. **配置环境变量**
   - 右键"此电脑" → 属性 → 高级系统设置 → 环境变量
   - 在"系统变量"中添加：
     - 变量名：`JAVA_HOME`
     - 变量值：`C:\Program Files\Eclipse Adoptium\jdk-17.x.x-hotspot`（你的实际安装路径）
   - 在 `Path` 变量中添加：`%JAVA_HOME%\bin`

4. **验证安装**
   ```bash
   java -version
   ```
   应该显示 Java 版本信息

### VS Code 配置（如果安装了 JDK）

在 VS Code 设置中（`Ctrl+,`），搜索 `java.home`，设置为你的 JDK 路径：
```json
{
  "java.home": "C:\\Program Files\\Eclipse Adoptium\\jdk-17.x.x-hotspot"
}
```

## 🎯 推荐做法

**对于你的项目，建议先尝试不安装 JDK：**

1. 直接按 `F5` 启动扩展
2. 如果出现错误，查看错误信息
3. 如果错误与 Java 无关，就不需要安装

你的项目是 TypeScript/Node.js 扩展，理论上不需要 Java。

## ❓ 如果还有问题

请告诉我：
1. 具体的错误信息是什么？
2. 在什么操作时出现的提示？（按 F5？编译？）
3. VS Code 输出面板（`Ctrl+Shift+U`）显示什么？

这样我可以更准确地帮你解决问题。

