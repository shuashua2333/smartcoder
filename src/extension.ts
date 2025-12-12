import * as vscode from 'vscode';
import axios from 'axios';      // 引入网络库
import * as cheerio from 'cheerio'; // 引入 HTML 解析库
import * as path from 'path';   // 引入路径处理库
import * as fs from 'fs';       // 引入文件系统库
import * as os from 'os';       // 引入操作系统库
import { exec, spawn } from 'child_process';  // 引入子进程库
import { promisify } from 'util';  // 引入工具函数

const execAsync = promisify(exec);

// === 差异视图内容提供者 ===
class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private _contentMap = new Map<string, string>();

    provideTextDocumentContent(uri: vscode.Uri): string {
        const content = this._contentMap.get(uri.toString());
        return content || '';
    }

    updateContent(uri: vscode.Uri, content: string) {
        this._contentMap.set(uri.toString(), content);
        this._onDidChange.fire(uri);
    }

    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = this._onDidChange.event;
}

// === 诊断树节点 ===
class DiagnosticTreeItem extends vscode.TreeItem {
    constructor(
        public readonly diagnostic: vscode.Diagnostic,
        public readonly documentUri: vscode.Uri,
        public readonly lineNumber: number
    ) {
        super(
            `第 ${lineNumber + 1} 行: ${diagnostic.message}`,
            vscode.TreeItemCollapsibleState.None
        );

        this.description = this._getSeverityText(diagnostic.severity);
        this.tooltip = `${diagnostic.message}\n来源: ${diagnostic.source || '未知'}\n点击跳转到错误位置`;
        this.contextValue = 'diagnostic';
        
        // 设置图标
        this.iconPath = this._getSeverityIcon(diagnostic.severity);
        
        // 添加命令，点击后跳转到错误位置
        this.command = {
            command: 'vscode.open',
            title: '跳转到错误',
            arguments: [
                documentUri,
                {
                    selection: diagnostic.range
                }
            ]
        };
    }

    private _getSeverityText(severity: vscode.DiagnosticSeverity): string {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error:
                return '错误';
            case vscode.DiagnosticSeverity.Warning:
                return '警告';
            case vscode.DiagnosticSeverity.Information:
                return '信息';
            case vscode.DiagnosticSeverity.Hint:
                return '提示';
            default:
                return '';
        }
    }

    private _getSeverityIcon(severity: vscode.DiagnosticSeverity): vscode.ThemeIcon {
        switch (severity) {
            case vscode.DiagnosticSeverity.Error:
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
            case vscode.DiagnosticSeverity.Warning:
                return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            case vscode.DiagnosticSeverity.Information:
                return new vscode.ThemeIcon('info', new vscode.ThemeColor('editorInfo.foreground'));
            case vscode.DiagnosticSeverity.Hint:
                return new vscode.ThemeIcon('lightbulb');
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}

// === 诊断树数据提供者 ===
class DiagnosticsTreeDataProvider implements vscode.TreeDataProvider<DiagnosticTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DiagnosticTreeItem | undefined | null | void> = 
        new vscode.EventEmitter<DiagnosticTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DiagnosticTreeItem | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    constructor(private readonly _sidebarProvider: SmartCoderSidebarProvider) {
        // 监听诊断变化
        vscode.languages.onDidChangeDiagnostics(() => {
            this.refresh();
        });

        // 监听编辑器切换
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DiagnosticTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DiagnosticTreeItem): Thenable<DiagnosticTreeItem[]> {
        if (!element) {
            // 根节点：返回当前文件的所有错误诊断
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                // 返回空数组，VS Code 会显示 "No items found"
                return Promise.resolve([]);
            }

            const document = editor.document;
            const uri = document.uri;
            
            // 只处理文本文件
            if (document.uri.scheme === 'output' || document.uri.scheme === 'debug') {
                return Promise.resolve([]);
            }

            const diagnostics = vscode.languages.getDiagnostics(uri);

            // 只显示错误级别的诊断（可以配置为显示所有级别）
            const errorDiagnostics = diagnostics.filter(
                d => d.severity === vscode.DiagnosticSeverity.Error
            );

            if (errorDiagnostics.length === 0) {
                return Promise.resolve([]);
            }

            const items = errorDiagnostics.map(diagnostic => {
                const lineNumber = diagnostic.range.start.line;
                return new DiagnosticTreeItem(diagnostic, uri, lineNumber);
            });

            // 按行号排序
            items.sort((a, b) => a.lineNumber - b.lineNumber);

            return Promise.resolve(items);
        }

        return Promise.resolve([]);
    }
}

export function activate(context: vscode.ExtensionContext) {
    // 0. 注册差异视图内容提供者
    const diffProvider = new DiffContentProvider();
    const diffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider('smartcoder-diff', diffProvider);
    context.subscriptions.push(diffProviderDisposable);

    // 1. 注册侧边栏
    const sidebarProvider = new SmartCoderSidebarProvider(context.extensionUri, diffProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("smartCoderView", sidebarProvider)
    );

    // 2. 注册诊断树视图
    const diagnosticsTreeProvider = new DiagnosticsTreeDataProvider(sidebarProvider);
    context.subscriptions.push(
        vscode.window.createTreeView('smartcoder-diagnostics', {
            treeDataProvider: diagnosticsTreeProvider,
            showCollapseAll: false
        })
    );

    // 3. 注册 AI 修复诊断命令
    context.subscriptions.push(
        vscode.commands.registerCommand('smartcoder.fixDiagnostic', async (item: DiagnosticTreeItem) => {
            await sidebarProvider.fixDiagnostic(item.diagnostic, item.documentUri, item.lineNumber);
        })
    );

    // 4. 注册快捷键命令 (Alt+A)
    context.subscriptions.push(
        vscode.commands.registerCommand('smartcoder.start', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.selection;
                const text = editor.document.getText(selection);
                // 即使没选中代码，也允许唤起侧边栏，方便刷题
                sidebarProvider.handleUserSelection(text); 
                vscode.commands.executeCommand('smartCoderView.focus'); 
            }
        })
    );

    // 5. 注册终端崩溃分析命令
    context.subscriptions.push(
        vscode.commands.registerCommand('smartcoder.analyzeTerminal', async () => {
            await sidebarProvider.analyzeRuntimeError();
        })
    );

    // 6. 注册生成单元测试命令
    context.subscriptions.push(
        vscode.commands.registerCommand('smartcoder.generateUnitTest', async () => {
            await sidebarProvider.generateUnitTest();
        })
    );

    // 7. 🔥 注册 URL 监听器 (监听 vscode://...)
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
                if (uri.path === '/solve') {
                    const query = new URLSearchParams(uri.query);
                    let title = query.get('title') || 'Unknown';
                    const id = query.get('id') || '0';
                    
                    // 解码 URL 编码的标题
                    try {
                        title = decodeURIComponent(title);
                    } catch (e) {
                        // 如果解码失败，使用原始值
                    }
                    
                    // 显示侧边栏视图
                    vscode.commands.executeCommand('smartCoderView.focus').then(() => {
                        // 延迟一点点，确保 Webview 准备好了
                        setTimeout(() => {
                            sidebarProvider.loadCloudProblem(title, id);
                        }, 500);
                    }, () => {
                        // 如果命令不存在，直接加载
                        setTimeout(() => {
                            sidebarProvider.loadCloudProblem(title, id);
                        }, 500);
                    });

                    vscode.window.showInformationMessage(`🔗 已连接云端题目：${title}`);
                }
            }
        })
    );
}

class SmartCoderSidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _history: { role: string, content: string }[] = [];
    private _currentProblemId: string = ""; // 🔥 当前云端题目ID

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _diffProvider: DiffContentProvider
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        // === 监听前端消息 ===
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'applyCode':
                    await this._applyCodeToEditor(data.value, data.diagnosticFix, data.unitTest);
                    break;
                case 'askAI':
                    // ✨ 修改：传入 useLocalModel 参数
                    this._callAiWithHistory(data.value, data.codeContext, data.useLocalModel);
                    break;
                case 'loadProblem': // 🔥 加载题目
                    this._handleLoadProblem(data.value);
                    break;
                case 'submitToCloud': // 🔥 云端提交
                    this._submitToCloud();
                    break;
            }
        });
    }

    public handleUserSelection(code: string) {
        if (this._view && code.trim()) {
            this._view.webview.postMessage({ type: 'setCodeContext', value: code });
        }
    }

    // 🔥 收到 URL 唤起时调用
    public loadCloudProblem(title: string, id: string) {
        this._currentProblemId = id;
        if (this._view) {
            // 确保视图可见
            this._view.show?.(true);
            this._view.webview.postMessage({ 
                type: 'setCloudMode', 
                title: title,
                id: id
            });
            // 自动生成模板代码
            this._applyCodeToEditor(`// Problem ID: ${id}\n// Title: ${title}\nusing System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello Cloud!");\n    }\n}`);
        }
    }

    // 🔥 本地运行代码并获取性能数据（类似 LeetCode 评测）
    private async _runCodeLocally(code: string): Promise<{ output: string; runtime: number; memory: number } | null> {
        const tempDir = path.join(os.tmpdir(), `smartcoder-${Date.now()}-${Math.random().toString(36).substring(7)}`);
        const projectDir = path.join(tempDir, 'CodeProject');
        
        try {
            // 1. 创建临时目录
            fs.mkdirSync(projectDir, { recursive: true });

            // 2. 创建 .csproj 文件
            const csprojContent = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>`;

            fs.writeFileSync(path.join(projectDir, 'CodeProject.csproj'), csprojContent);

            // 3. 智能提取用户代码并包装
            // 检测用户代码结构，提取核心代码片段
            let userCodeSnippet = code;
            
            // 检测是否包含 Main 方法
            const mainMethodRegex = /static\s+(void|int)\s+Main\s*\([^)]*\)\s*\{/i;
            const mainMatch = code.match(mainMethodRegex);
            
            if (mainMatch) {
                // 如果包含 Main 方法，提取 Main 方法内部的代码
                const mainStartIndex = mainMatch.index! + mainMatch[0].length;
                
                // 找到匹配的右大括号（Main 方法结束）
                let braceCount = 1;
                let mainEndIndex = mainStartIndex;
                
                for (let i = mainStartIndex; i < code.length; i++) {
                    if (code[i] === '{') braceCount++;
                    if (code[i] === '}') {
                        braceCount--;
                        if (braceCount === 0) {
                            mainEndIndex = i;
                            break;
                        }
                    }
                }
                
                // 提取 Main 方法内部的代码
                if (mainEndIndex > mainStartIndex) {
                    userCodeSnippet = code.substring(mainStartIndex, mainEndIndex).trim();
                }
            } else {
                // 检测是否包含完整的类定义
                const classRegex = /class\s+\w+\s*\{/i;
                const classMatch = code.match(classRegex);
                
                if (classMatch) {
                    // 如果包含类定义，提取类内部的代码
                    const classStartIndex = classMatch.index! + classMatch[0].length;
                    
                    // 找到匹配的右大括号（类结束）
                    let braceCount = 1;
                    let classEndIndex = classStartIndex;
                    
                    for (let i = classStartIndex; i < code.length; i++) {
                        if (code[i] === '{') braceCount++;
                        if (code[i] === '}') {
                            braceCount--;
                            if (braceCount === 0) {
                                classEndIndex = i;
                                break;
                            }
                        }
                    }
                    
                    // 提取类内部的代码
                    if (classEndIndex > classStartIndex) {
                        userCodeSnippet = code.substring(classStartIndex, classEndIndex).trim();
                    }
                }
            }
            
            // 如果提取的代码为空，使用原始代码
            if (!userCodeSnippet || userCodeSnippet.trim() === '') {
                userCodeSnippet = code;
            }
            
            // 包装代码，添加性能监控
            const wrappedCode = `using System;
using System.Diagnostics;

class Program
{
    static void Main()
    {
        var sw = Stopwatch.StartNew();
        long memoryBefore = GC.GetTotalMemory(false);
        
        try
        {
            // ========== 用户代码开始 ==========
${userCodeSnippet}
            // ========== 用户代码结束 ==========
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("EXCEPTION: " + ex.ToString());
        }
        finally
        {
            sw.Stop();
            long memoryAfter = GC.GetTotalMemory(false);
            long memoryUsed = Math.Max(0, memoryAfter - memoryBefore);
            
            // 输出性能数据（使用特殊标记，方便解析）
            Console.WriteLine("\\n===SMARTCODER_PERF_START===");
            Console.WriteLine($"RUNTIME_MS:{sw.ElapsedMilliseconds}");
            Console.WriteLine($"MEMORY_BYTES:{memoryUsed}");
            Console.WriteLine("===SMARTCODER_PERF_END===");
        }
    }
}`;

            // 4. 写入 Program.cs
            fs.writeFileSync(path.join(projectDir, 'Program.cs'), wrappedCode, 'utf8');

            // 5. 先检查 dotnet 是否可用
            try {
                await execAsync('dotnet --version', { timeout: 5000 });
            } catch (checkError) {
                throw new Error('dotnet command not found. Please install .NET SDK from https://dotnet.microsoft.com/download');
            }

            // 6. 先构建项目，再运行
            const command = process.platform === 'win32' ? 'dotnet' : 'dotnet';
            
            // 先构建（这会自动编译代码）
            try {
                await execAsync(`${command} build`, {
                    cwd: projectDir,
                    timeout: 30000,
                    maxBuffer: 1024 * 1024 * 10
                });
            } catch (buildError: any) {
                // 构建失败，返回构建错误信息
                const buildOutput = buildError.stdout || buildError.stderr || buildError.message;
                throw new Error(`编译失败：\n${buildOutput}`);
            }
            
            // 构建成功后运行
            const runResult = await execAsync(`${command} run`, {
                cwd: projectDir,
                timeout: 30000, // 30秒超时
                maxBuffer: 1024 * 1024 * 10 // 10MB 缓冲区
            });

            const stdout = runResult.stdout || '';
            const stderr = runResult.stderr || '';

            // 6. 解析输出，提取性能数据
            const perfStart = stdout.indexOf('===SMARTCODER_PERF_START===');
            const perfEnd = stdout.indexOf('===SMARTCODER_PERF_END===');

            let output = stdout;
            let runtime = 0;
            let memory = 0;

            if (perfStart !== -1 && perfEnd !== -1) {
                // 提取实际输出（性能数据之前的部分）
                output = stdout.substring(0, perfStart).trim();
                
                // 提取性能数据
                const perfSection = stdout.substring(perfStart, perfEnd);
                const runtimeMatch = perfSection.match(/RUNTIME_MS:(\d+)/);
                const memoryMatch = perfSection.match(/MEMORY_BYTES:(\d+)/);

                if (runtimeMatch) {
                    runtime = parseInt(runtimeMatch[1], 10);
                }
                if (memoryMatch) {
                    memory = parseInt(memoryMatch[1], 10);
                }
            }

            // 如果有 stderr，附加到输出
            if (stderr && !stderr.includes('Build succeeded')) {
                output += (output ? '\n' : '') + stderr;
            }

            return { output, runtime, memory };

        } catch (error: any) {
            // 如果运行失败，返回详细的错误信息
            let errorOutput = '';
            
            // 检查是否是 .NET SDK 未安装
            if (error.message && (error.message.includes('dotnet') || error.message.includes('not found') || error.message.includes('不是内部或外部命令'))) {
                errorOutput = '❌ 错误：未检测到 .NET SDK\n\n请先安装 .NET SDK：\n1. 访问 https://dotnet.microsoft.com/download\n2. 下载并安装 .NET SDK 6.0 或更高版本\n3. 安装后运行 "dotnet --version" 验证';
            } else if (error.stdout) {
                // 如果有 stdout，可能是编译错误
                errorOutput = `编译/运行错误：\n${error.stdout}`;
                if (error.stderr) {
                    errorOutput += `\n${error.stderr}`;
                }
            } else if (error.stderr) {
                errorOutput = `错误：\n${error.stderr}`;
            } else {
                errorOutput = `代码运行失败：${error.message || '未知错误'}`;
            }
            
            return { 
                output: errorOutput, 
                runtime: -1, 
                memory: -1 
            };
        } finally {
            // 7. 清理临时目录
            try {
                if (fs.existsSync(tempDir)) {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            } catch (cleanupError) {
                // 清理失败不影响主流程，只记录错误
                console.error('清理临时目录失败:', cleanupError);
            }
        }
    }

    // 🔥 发送代码给后端 Server（已添加性能评测）
    private async _submitToCloud() {
        if (!this._view) return;
        
        // 从活动编辑器获取代码
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : "";
        
        if (!code) {
            vscode.window.showWarningMessage("当前没有打开的编辑器或文件为空");
            return;
        }

        this._view.webview.postMessage({ type: 'addUserMessage', value: "⚡ 正在本地运行代码并评测性能..." });

        try {
            // 1. 先在本地运行代码，获取性能数据
            const perfData = await this._runCodeLocally(code);

            if (!perfData) {
                throw new Error("本地运行失败");
            }

            // 2. 显示性能数据和运行结果
            let perfInfo = '';
            let statusIcon = '✅';
            
            if (perfData.runtime >= 0 && perfData.memory >= 0) {
                // 成功获取性能数据
                perfInfo = `\n\n⚡ **性能数据**\n- 运行时间: ${perfData.runtime}ms\n- 内存使用: ${(perfData.memory / 1024).toFixed(2)}KB`;
                if (perfData.output) {
                    perfInfo += `\n\n📤 **程序输出:**\n\`\`\`\n${perfData.output}\n\`\`\``;
                }
            } else {
                // 性能数据获取失败
                statusIcon = '⚠️';
                perfInfo = `\n\n⚠️ **性能数据获取失败**`;
                
                // 显示错误信息
                if (perfData.output) {
                    perfInfo += `\n\n❌ **错误信息:**\n\`\`\`\n${perfData.output}\n\`\`\``;
                    
                    // 检查是否是 .NET SDK 问题
                    if (perfData.output.includes('.NET SDK') || perfData.output.includes('dotnet')) {
                        perfInfo += `\n\n💡 **解决方案:**\n请安装 .NET SDK：\n1. 访问 https://dotnet.microsoft.com/download\n2. 下载并安装 .NET SDK 6.0 或更高版本\n3. 重启 VS Code`;
                    }
                } else {
                    perfInfo += `\n\n可能的原因：\n- .NET SDK 未安装\n- 代码编译失败\n- 代码运行超时（30秒）`;
                }
            }

            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { 
                    analysis: `${statusIcon} **本地运行完成**${perfInfo}\n\n📤 正在提交到云端...`, 
                    code: null 
                } 
            });

            // 3. 发送给后端服务器（包含性能数据）
            const response = await axios.post('http://localhost:3000/api/submit', {
                problemId: this._currentProblemId || "Unknown",
                code: code,
                output: perfData.output,
                runtime: perfData.runtime,
                memory: perfData.memory,
                timestamp: Date.now()
            });
            
            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: "✅ **提交成功！**\n\n请切换回网页端查看 AI 导师的详细反馈。", code: null } 
            });
            vscode.window.showInformationMessage("提交成功！请查看网页端反馈。");
            
        } catch (e: any) {
            const errorMsg = e.message || "请确保后端服务器已启动 (http://localhost:3000)";
            vscode.window.showErrorMessage("连接云端失败: " + errorMsg);
            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: `❌ 提交失败: ${errorMsg}\n\n请检查：\n1. Node 服务器是否启动在 http://localhost:3000\n2. 是否已安装 .NET SDK (dotnet --version)`, code: null } 
            });
        }
    }

    // === 🔥 新增功能：分析运行时崩溃错误 ===
    public async analyzeRuntimeError() {
        if (!this._view) {
            // 如果侧边栏未打开，先打开它
            await vscode.commands.executeCommand('smartCoderView.focus');
            // 等待一下让侧边栏初始化
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        try {
            // 1. 获取终端选中的文本（报错堆栈）
            // 方案：先尝试从剪贴板读取（用户可能已经复制了）
            // 如果没有合适的文本，再尝试自动复制终端选中内容
            
            let errorLog = '';
            let previousClipboard = '';
            
            // 先读取当前剪贴板内容
            previousClipboard = await vscode.env.clipboard.readText();
            
            // 如果剪贴板内容看起来像错误堆栈（包含常见错误关键词），直接使用
            const errorKeywords = ['Exception', 'Error', 'Stack Trace', 'at ', 'System.', 'Unhandled', 'NullReference', 'IndexOutOfRange'];
            const looksLikeError = errorKeywords.some(keyword => previousClipboard.includes(keyword));
            
            if (looksLikeError && previousClipboard.trim().length > 20) {
                // 剪贴板内容看起来像错误信息，直接使用
                errorLog = previousClipboard;
                vscode.window.showInformationMessage('检测到剪贴板中的错误信息，正在分析...');
            } else {
                // 尝试从终端复制选中内容
                await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
                await new Promise(resolve => setTimeout(resolve, 150));
                
                errorLog = await vscode.env.clipboard.readText();
                
                // 如果复制后还是没有合适的错误信息
                if (!errorLog.trim() || errorLog === previousClipboard) {
                    // 提示用户手动复制错误信息
                    const action = await vscode.window.showWarningMessage(
                        '未检测到错误信息。\n\n使用方法：\n1. 在终端中选中报错信息（会自动复制）\n2. 按 Ctrl+Shift+E 或通过命令面板运行"SmartCoder: 分析运行时错误"',
                        '打开命令面板', '知道了'
                    );
                    
                    if (action === '打开命令面板') {
                        await vscode.commands.executeCommand('workbench.action.showCommands');
                    }
                    return;
                }
            }
            
            // 验证错误信息是否有效
            if (!errorLog.trim() || errorLog.length < 10) {
                vscode.window.showWarningMessage('错误信息太短，请确保已选中完整的报错堆栈');
                return;
            }

            // 2. 获取当前编辑器的源代码
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('请先打开源代码文件');
                return;
            }

            const sourceCode = editor.document.getText();
            const fileName = editor.document.fileName.split(/[/\\]/).pop() || 'unknown';
            const languageId = editor.document.languageId;

            // 3. 显示加载状态
            this._view?.webview.postMessage({ 
                type: 'addUserMessage', 
                value: `🔍 正在分析运行时错误...` 
            });
            this._view?.webview.postMessage({ type: 'showLoading' });

            // 4. 构造分析 Prompt
            const prompt = `我的C#程序运行时崩溃了。

**控制台报错信息：**
\`\`\`
${errorLog}
\`\`\`

**源代码文件：** ${fileName} (${languageId})
**完整源代码：**
\`\`\`${languageId}
${sourceCode}
\`\`\`

请帮我：
1. **分析错误原因**：详细解释这个错误是什么，为什么会发生。
2. **定位问题行数**：明确指出是源代码的第几行导致了这个问题（如果堆栈跟踪中有行号，请结合源代码验证）。
3. **给出修复建议**：提供修复后的代码片段。

⚠️ 必须返回 JSON 格式：{ "analysis": "Markdown格式的分析文本（包含行号定位）", "code": "修复后的完整代码或关键代码片段（如果是完整代码，包含所有必要的using语句和类结构）" }`;

            // 5. 调用 AI 分析
            await this._callAiWithHistory(prompt, "RUNTIME_ERROR_ANALYSIS");

            // 6. 聚焦到侧边栏
            await vscode.commands.executeCommand('smartCoderView.focus');

        } catch (error: any) {
            vscode.window.showErrorMessage(`分析失败: ${error.message}`);
            this._view?.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: `❌ 分析失败: ${error.message}`, code: null } 
            });
        }
    }

    // === 🔥 新增功能：生成单元测试 ===
    public async generateUnitTest() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开一个 C# 文件');
            return;
        }

        const document = editor.document;
        if (document.languageId !== 'csharp') {
            vscode.window.showWarningMessage('此功能仅支持 C# 文件');
            return;
        }

        // 获取选中的代码或光标所在位置的函数
        let selectedText = '';
        let functionRange: vscode.Range | null = null;

        if (!editor.selection.isEmpty) {
            // 用户选中了代码
            selectedText = document.getText(editor.selection);
            functionRange = editor.selection;
        } else {
            // 用户没有选中代码，尝试自动检测光标所在的函数
            const position = editor.selection.active;
            const detectedFunction = this._detectFunctionAtPosition(document, position);
            if (detectedFunction) {
                selectedText = detectedFunction.code;
                functionRange = detectedFunction.range;
            } else {
                vscode.window.showWarningMessage('请选中一个函数或方法，或将光标放在函数内部');
                return;
            }
        }

        if (!selectedText.trim()) {
            vscode.window.showWarningMessage('未检测到有效的函数代码');
            return;
        }

        // 解析函数信息
        const functionInfo = this._parseFunctionInfo(selectedText, document, functionRange!);
        if (!functionInfo) {
            vscode.window.showWarningMessage('无法解析函数信息，请确保选中的是完整的函数定义');
            return;
        }

        // 获取完整的文件上下文（用于了解命名空间、类名等）
        const fullText = document.getText();
        const namespaceMatch = fullText.match(/namespace\s+([\w.]+)/);
        const classMatch = fullText.match(/(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:sealed\s+)?(?:abstract\s+)?class\s+(\w+)/);
        
        const namespace = namespaceMatch ? namespaceMatch[1] : '';
        const className = classMatch ? classMatch[1] : '';

        // 打开侧边栏
        if (!this._view) {
            await vscode.commands.executeCommand('smartCoderView.focus');
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        // 显示加载状态
        this._view?.webview.postMessage({ 
            type: 'addUserMessage', 
            value: `🧪 正在为函数 ${functionInfo.name} 生成单元测试...` 
        });
        this._view?.webview.postMessage({ type: 'showLoading' });

        // 构造 Prompt
        const prompt = `请为以下 C# 函数生成完整的单元测试代码。

**函数信息：**
- 函数名：${functionInfo.name}
- 返回类型：${functionInfo.returnType || 'void'}
- 参数：${functionInfo.parameters.length > 0 ? functionInfo.parameters.map((p: { type: string, name: string }) => `${p.type} ${p.name}`).join(', ') : '无'}
- 所在类：${className || '未知'}
- 命名空间：${namespace || '未知'}

**函数代码：**
\`\`\`csharp
${selectedText}
\`\`\`

**要求：**
1. 使用 xUnit 或 NUnit 测试框架（优先使用 xUnit）
2. 生成完整的测试类，包含必要的 using 语句
3. 覆盖以下测试场景：
   - 正常情况（典型输入）
   - 边界条件（如输入为 0、负数、空值、最大值、最小值等）
   - 异常情况（如无效输入、空引用等，如果函数可能抛出异常）
4. 每个测试方法应该有清晰的名称，描述测试的场景
5. 使用 [Fact] 或 [Test] 特性标记测试方法
6. 包含必要的断言（Assert）

⚠️ 必须返回 JSON 格式：{ "analysis": "Markdown格式的测试说明（包含测试覆盖的场景说明）", "code": "完整的测试类代码（包含所有必要的 using 语句和命名空间）" }`;

        // 调用 AI 生成测试代码
        await this._callAiForUnitTest(prompt, functionInfo, document, functionRange!);

        // 聚焦到侧边栏
        await vscode.commands.executeCommand('smartCoderView.focus');
    }

    // === AI 生成单元测试专用调用 ===
    private async _callAiForUnitTest(
        prompt: string,
        functionInfo: any,
        document: vscode.TextDocument,
        functionRange: vscode.Range
    ) {
        if (!this._view) return;

        try {
            const config = vscode.workspace.getConfiguration('smartcoder');
            const apiKey = config.get<string>('apiKey');

            if (!apiKey) {
                this._view.webview.postMessage({ 
                    type: 'addAiMessage', 
                    data: { analysis: "❌ 请先配置 API Key", code: null } 
                });
                return;
            }

            const systemPrompt = `你是一个专业的 C# 单元测试生成专家，擅长使用 xUnit 和 NUnit 框架编写全面的单元测试。

你的任务是：
1. 仔细分析函数逻辑，理解函数的输入输出和边界条件
2. 生成全面的单元测试，覆盖正常情况、边界条件和异常情况
3. 使用清晰的测试方法命名，遵循 Arrange-Act-Assert 模式
4. 确保测试代码可以直接运行，包含所有必要的 using 语句和命名空间

⚠️ 必须且只能返回 JSON 格式：{ "analysis": "Markdown格式的测试说明", "code": "完整的测试类代码" }
不要使用 markdown 代码块包裹 JSON。`;

            const response = await fetch("https://api.deepseek.com/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: "deepseek-chat",
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: prompt }
                    ],
                    response_format: { type: 'json_object' },
                    stream: false
                })
            });

            const data = await response.json() as any;
            if (!response.ok) throw new Error(data.error?.message || "API Error");
            
            const aiRawContent = data.choices[0].message.content;
            let aiJson;
            try {
                aiJson = JSON.parse(aiRawContent.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                aiJson = { analysis: aiRawContent, code: null };
            }

            // 将测试代码信息发送到侧边栏，并附加函数信息以便应用
            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: {
                    ...aiJson,
                    _unitTest: {
                        functionName: functionInfo.name,
                        documentUri: document.uri.toString(),
                        functionRange: {
                            start: functionRange.start,
                            end: functionRange.end
                        }
                    }
                }
            });

        } catch (error: any) {
            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: `❌ 生成失败: ${error.message}`, code: null } 
            });
        }
    }

    // === 解析函数信息 ===
    private _parseFunctionInfo(code: string, document: vscode.TextDocument, range: vscode.Range): any | null {
        const trimmedCode = code.trim();
        
        // 匹配 C# 方法定义
        // 模式：访问修饰符 [static] [async] 返回类型 方法名(参数)
        const methodRegex = /\b(public|private|protected|internal)\s+(static\s+)?(async\s+)?(\w+(?:<[\w\s,]+>)?\s+)?(\w+)\s*\(([^)]*)\)/;
        const match = trimmedCode.match(methodRegex);
        
        if (!match) {
            // 尝试匹配构造函数
            const constructorRegex = /\b(public|private|protected|internal)\s+(\w+)\s*\(([^)]*)\)/;
            const constructorMatch = trimmedCode.match(constructorRegex);
            if (constructorMatch) {
                return {
                    name: constructorMatch[2],
                    returnType: null,
                    parameters: this._parseParameters(constructorMatch[3] || ''),
                    isConstructor: true
                };
            }
            return null;
        }

        const returnType = match[4] ? match[4].trim() : 'void';
        const methodName = match[5];
        const parametersStr = match[6] || '';

        return {
            name: methodName,
            returnType: returnType,
            parameters: this._parseParameters(parametersStr),
            isConstructor: false
        };
    }

    // === 解析参数列表 ===
    private _parseParameters(parametersStr: string): Array<{ type: string, name: string }> {
        if (!parametersStr.trim()) {
            return [];
        }

        const parameters: Array<{ type: string, name: string }> = [];
        const paramParts = parametersStr.split(',').map(p => p.trim());

        for (const param of paramParts) {
            // 匹配参数：类型 参数名 [= 默认值]
            const paramMatch = param.match(/(\w+(?:<[\w\s,]+>)?(?:\[\])?)\s+(\w+)(?:\s*=.*)?/);
            if (paramMatch) {
                parameters.push({
                    type: paramMatch[1],
                    name: paramMatch[2]
                });
            }
        }

        return parameters;
    }

    // === 检测光标位置的函数 ===
    private _detectFunctionAtPosition(document: vscode.TextDocument, position: vscode.Position): { code: string, range: vscode.Range } | null {
        const text = document.getText();
        const offset = document.offsetAt(position);

        // 向前查找函数定义的开始（查找方法签名）
        let startOffset = offset;
        let braceCount = 0;
        let foundMethodStart = false;
        let methodStartPos = -1;

        // 先向前找到方法签名
        for (let i = offset; i >= 0; i--) {
            const char = text[i];
            
            if (char === '}') {
                braceCount++;
            } else if (char === '{') {
                if (braceCount === 0) {
                    // 找到了方法体的开始
                    foundMethodStart = true;
                    methodStartPos = i;
                    break;
                }
                braceCount--;
            }
        }

        if (!foundMethodStart) {
            return null;
        }

        // 继续向前查找方法签名的开始（查找 public/private 等关键字）
        let methodSignatureStart = methodStartPos;
        for (let i = methodStartPos - 1; i >= 0; i--) {
            const char = text[i];
            if (char === '\n' || char === ';') {
                // 检查前面是否有方法定义的关键字
                const beforeText = text.substring(Math.max(0, i - 50), i);
                if (beforeText.match(/\b(public|private|protected|internal)\s+(static\s+)?(async\s+)?(\w+\s+)?(\w+)\s*\(/)) {
                    methodSignatureStart = i + 1;
                    break;
                }
            }
        }

        // 向后查找函数定义的结束（匹配大括号）
        let endOffset = methodStartPos + 1;
        braceCount = 1;
        let inString = false;
        let stringChar = '';

        for (let i = methodStartPos + 1; i < text.length; i++) {
            const char = text[i];
            const prevChar = i > 0 ? text[i - 1] : '';

            // 处理字符串
            if (!inString && (char === '"' || char === "'")) {
                inString = true;
                stringChar = char;
            } else if (inString && char === stringChar && prevChar !== '\\') {
                inString = false;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        endOffset = i + 1;
                        break;
                    }
                }
            }
        }

        if (braceCount !== 0) {
            return null; // 大括号不匹配
        }

        const startPos = document.positionAt(methodSignatureStart);
        const endPos = document.positionAt(endOffset);
        const range = new vscode.Range(startPos, endPos);
        const code = document.getText(range);

        return { code, range };
    }

    // === 🔥 新增功能：AI 修复诊断错误 ===
    public async fixDiagnostic(diagnostic: vscode.Diagnostic, documentUri: vscode.Uri, lineNumber: number) {
        if (!this._view) {
            // 如果侧边栏未打开，先打开它
            await vscode.commands.executeCommand('smartCoderView.focus');
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        try {
            // 1. 获取文档内容
            const document = await vscode.workspace.openTextDocument(documentUri);
            const fullText = document.getText();
            const lines = fullText.split('\n');
            const languageId = document.languageId;

            // 2. 提取错误所在行的代码和上下文（前后各 5 行）
            const startLine = Math.max(0, lineNumber - 5);
            const endLine = Math.min(lines.length - 1, lineNumber + 5);
            const contextLines = lines.slice(startLine, endLine + 1);
            const errorLineIndex = lineNumber - startLine;
            const contextCode = contextLines.join('\n');

            // 3. 提取错误行的代码
            const errorLineCode = lines[lineNumber] || '';

            // 4. 显示加载状态
            this._view?.webview.postMessage({ 
                type: 'addUserMessage', 
                value: `🔧 正在修复第 ${lineNumber + 1} 行的错误...` 
            });
            this._view?.webview.postMessage({ type: 'showLoading' });

            // 5. 构造修复 Prompt
            const prompt = `我正在修复一个编译错误（基于 LSP 诊断）。

**文件类型：** ${languageId}
**错误位置：** 第 ${lineNumber + 1} 行
**错误信息：** ${diagnostic.message}
**错误来源：** ${diagnostic.source || '未知'}

**出错的代码行：**
\`\`\`
${errorLineCode}
\`\`\`

**上下文代码（包含错误行，前后各 5 行）：**
\`\`\`${languageId}
${contextCode}
\`\`\`

**错误范围：** 第 ${diagnostic.range.start.character + 1} 列 到 第 ${diagnostic.range.end.character + 1} 列

请帮我：
1. **分析错误原因**：详细解释为什么会出现这个编译错误。
2. **提供修复方案**：给出修复后的代码（只需要修复的部分，可以是单行、多行或整个代码块）。

⚠️ 必须返回 JSON 格式：{ "analysis": "Markdown格式的分析文本", "code": "修复后的代码片段（只包含需要修改的部分，保持原有缩进）" }`;

            // 6. 调用 AI 修复
            await this._callAiForDiagnosticFix(prompt, diagnostic, documentUri, lineNumber, errorLineCode, contextCode);

            // 7. 聚焦到侧边栏
            await vscode.commands.executeCommand('smartCoderView.focus');

        } catch (error: any) {
            vscode.window.showErrorMessage(`修复失败: ${error.message}`);
            this._view?.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: `❌ 修复失败: ${error.message}`, code: null } 
            });
        }
    }

    // === AI 诊断修复专用调用（支持精确代码替换） ===
    private async _callAiForDiagnosticFix(
        prompt: string,
        diagnostic: vscode.Diagnostic,
        documentUri: vscode.Uri,
        lineNumber: number,
        errorLineCode: string,
        contextCode: string
    ) {
        if (!this._view) return;

        try {
            const config = vscode.workspace.getConfiguration('smartcoder');
            const apiKey = config.get<string>('apiKey');

            if (!apiKey) {
                this._view.webview.postMessage({ 
                    type: 'addAiMessage', 
                    data: { analysis: "❌ 请先配置 API Key", code: null } 
                });
                return;
            }

            const systemPrompt = `你是一个专业的代码修复专家，擅长 Automated Program Repair (APR，自动程序修复)。

你的任务是：
1. 仔细分析 LSP 诊断错误信息，理解错误的根本原因
2. 提供精确的代码修复方案，只修复错误部分，不要改变其他无关代码
3. 保持代码风格和缩进一致

⚠️ 必须且只能返回 JSON 格式：{ "analysis": "Markdown格式的详细分析", "code": "修复后的代码片段（保持原缩进，可以是单行或多行）" }
不要使用 markdown 代码块包裹 JSON。`;

            const response = await fetch("https://api.deepseek.com/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: "deepseek-chat",
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: prompt }
                    ],
                    response_format: { type: 'json_object' },
                    stream: false
                })
            });

            const data = await response.json() as any;
            if (!response.ok) throw new Error(data.error?.message || "API Error");
            
            const aiRawContent = data.choices[0].message.content;
            let aiJson;
            try {
                aiJson = JSON.parse(aiRawContent.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                aiJson = { analysis: aiRawContent, code: null };
            }

            // 增强 AI 响应，添加应用修复的功能
            if (aiJson.code && aiJson.code.trim() !== "null") {
                // 将修复信息发送到侧边栏，并附加文档信息以便应用
                this._view.webview.postMessage({ 
                    type: 'addAiMessage', 
                    data: {
                        ...aiJson,
                        _diagnosticFix: {
                            documentUri: documentUri.toString(),
                            lineNumber: lineNumber,
                            range: {
                                start: diagnostic.range.start,
                                end: diagnostic.range.end
                            },
                            errorLineCode: errorLineCode
                        }
                    }
                });
            } else {
                this._view.webview.postMessage({ 
                    type: 'addAiMessage', 
                    data: aiJson 
                });
            }

        } catch (error: any) {
            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: `❌ 错误: ${error.message}`, code: null } 
            });
        }
    }

    // === 🔥 新增功能：处理题目加载 ===
    private async _handleLoadProblem(input: string) {
        if (!this._view) return;

        // 1. 通知前端显示加载状态
        this._view.webview.postMessage({ type: 'addUserMessage', value: `📚 正在获取题目: ${input}...` });
        this._view.webview.postMessage({ type: 'showLoading' });

        try {
            let problemContext = "";
            let source = "AI_KNOWLEDGE_BASE";

            // 2. 简单的爬虫逻辑 (体现工作量)
            if (input.includes("luogu")) {
                source = "LUOGU_CRAWLER";
                problemContext = await this._scrapeLuogu(input);
            } else if (input.includes("leetcode") || input.startsWith("http")) {
                // 对于力扣（反爬很严）或其他网站，我们演示“尝试爬取失败后回退到 AI 知识库”
                // 或者简单提取 URL，让 AI 自己去分析
                problemContext = `题目链接: ${input} (请基于你的知识库尝试解析此题目)`;
            } else {
                // 纯文本输入（如 "两数之和"）
                problemContext = `题目名称: ${input}`;
            }

            // 3. 构造 Prompt，要求生成 C# 模板
            const prompt = `我正在解决这个编程题目（来源: ${source}）：
            ${problemContext}

            请你：
            1. 简要分析题目要点。
            2. 生成一个 C# 的解题代码模板（包含类、Main函数或Solution方法），方法体留空。
            
            ⚠️ 必须返回 JSON 格式： { "analysis": "...", "code": "..." }`;

            // 4. 调用 AI
            await this._callAiWithHistory(prompt, "SYSTEM_PROBLEM_MODE");

        } catch (error: any) {
            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: `❌ 题目加载失败: ${error.message}`, code: null } 
            });
        }
    }

    // === 🔥 爬虫逻辑：爬取洛谷 (示例) ===
    private async _scrapeLuogu(url: string): Promise<string> {
        try {
            // 设置 User-Agent 伪装浏览器
            const response = await axios.get(url, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' 
                }
            });
            
            const $ = cheerio.load(response.data);
            
            // 提取标题和内容 (根据洛谷网页结构)
            // 注意：如果洛谷改版，这里可能需要微调选择器，但这在演示中足够说明原理
            const title = $('h1').text().trim();
            // 洛谷题目描述通常在 markdown-body 类中
            const description = $('.markdown-body').text().trim().substring(0, 1500); // 截取前1500字

            if (!title) throw new Error("未找到题目内容");

            return `[洛谷题目] ${title}\n\n描述摘要：${description}...`;
        } catch (e: any) {
            console.error(e);
            return `爬取失败 (${e.message})，正在尝试通过 AI 知识库检索该题目...`;
        }
    }

    // === 通用 AI 调用 (JSON 模式) ===
    private async _callAiWithHistory(userMessage: string, codeContext: string = "", useLocalModel: boolean = false) {
        if (!this._view) return;

        // 对于崩溃分析模式，userMessage 已经包含了完整的错误信息和源代码
        // 对于其他模式，需要组合 codeContext 和 userMessage
        const fullMessage = (codeContext === "RUNTIME_ERROR_ANALYSIS" || codeContext === "SYSTEM_PROBLEM_MODE")
            ? userMessage  // 这些模式下，userMessage 已经是完整的 prompt
            : (codeContext 
            ? `代码上下文:\n${codeContext}\n\n用户问题: ${userMessage}` 
                : userMessage);

        // 对于崩溃分析和题目加载，使用简化的历史记录（避免完整源代码占用太多 token）
        if (codeContext === "RUNTIME_ERROR_ANALYSIS") {
            // 只保存错误摘要，不保存完整源代码
            const errorMatch = userMessage.match(/\*\*控制台报错信息：\*\*\s*```[\s\S]*?```/);
            const errorSummary = errorMatch ? errorMatch[0].substring(0, 200) + '...' : '运行时错误分析';
            this._history.push({ role: 'user', content: `分析运行时错误: ${errorSummary}` });
        } else if (codeContext === "SYSTEM_PROBLEM_MODE") {
            // 题目加载模式也简化历史记录
            const problemMatch = userMessage.match(/我正在解决这个编程题目[^\n]*\n\s*([^\n]+)/);
            const problemSummary = problemMatch ? problemMatch[1].substring(0, 100) : '编程题目';
            this._history.push({ role: 'user', content: `加载题目: ${problemSummary}...` });
        } else {
            // 其他情况正常加入历史记录
        this._history.push({ role: 'user', content: fullMessage });
        }
        
        // 如果不是由 _handleLoadProblem 触发的 loading，这里补一个
        // (简单起见，我们假设前端已经 handle 了 loading，或者重复发也没事)
        
        try {
            let apiUrl = "https://api.deepseek.com/chat/completions";
            let modelName = "deepseek-chat";
            let apiKey = vscode.workspace.getConfiguration('smartcoder').get<string>('apiKey');

            // ✨ 新增：如果是本地模式，修改配置
            if (useLocalModel) {
                apiUrl = "http://localhost:11434/v1/chat/completions";
                modelName = "qwen2.5-coder:7b"; // 确保你本地有这个模型
                apiKey = "ollama"; // Ollama 不需要真实 key，但不传可能会报错
            } else {
                // DeepSeek 模式检查 Key
                if (!apiKey) {
                    this._view.webview.postMessage({ 
                        type: 'addAiMessage', 
                        data: { analysis: "❌ 请先配置 DeepSeek API Key", code: null } 
                    });
                    return;
                }
            }

            // 根据不同的上下文模式使用不同的系统提示词
            let systemPrompt = `你是一个 C# 竞赛编程专家。
            ⚠️ 必须且只能返回 JSON 格式：{ "analysis": "Markdown文本", "code": "C#代码或null" }
            不要使用 markdown 代码块包裹 JSON。`;

            if (codeContext === "RUNTIME_ERROR_ANALYSIS") {
                systemPrompt = `你是一个专业的 C# 调试专家，擅长分析运行时错误和堆栈跟踪。
                
你的任务是：
1. 仔细分析堆栈跟踪信息，定位错误发生的具体位置
2. 结合源代码，指出导致错误的代码行数
3. 解释错误原因（空引用、数组越界、类型转换等）
4. 提供修复后的代码

⚠️ 必须且只能返回 JSON 格式：{ "analysis": "Markdown格式的详细分析（必须包含具体的行号定位）", "code": "修复后的完整代码或关键代码片段" }
不要使用 markdown 代码块包裹 JSON。`;
            }

            // 构造消息数组：对于崩溃分析和题目加载，使用完整的 fullMessage 而不是历史记录
            const messages = [
                { role: "system", content: systemPrompt }
            ];
            
            if (codeContext === "RUNTIME_ERROR_ANALYSIS" || codeContext === "SYSTEM_PROBLEM_MODE") {
                // 这些模式使用完整的 prompt，不依赖历史记录
                messages.push({ role: "user", content: fullMessage });
            } else {
                // 其他模式使用历史记录（包含上下文）
                messages.push(...this._history);
            }

            // 发送请求
            const response = await fetch(apiUrl, { // 使用动态的 apiUrl
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName, // 使用动态的 modelName
                    messages: messages, // 使用上面构建好的 messages
                    response_format: { type: 'json_object' },
                    stream: false
                })
            });

            const data = await response.json() as any;
            if (!response.ok) throw new Error(data.error?.message || "API Error");
            
            const aiRawContent = data.choices[0].message.content;
            let aiJson;
            try {
                aiJson = JSON.parse(aiRawContent.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                aiJson = { analysis: aiRawContent, code: null };
            }

            this._history.push({ role: 'assistant', content: aiRawContent });
            this._view.webview.postMessage({ type: 'addAiMessage', data: aiJson });

        } catch (error: any) {
            this._view.webview.postMessage({ 
                type: 'addAiMessage', 
                data: { analysis: `❌ 错误: ${error.message}`, code: null } 
            });
        }
    }

    // === 🔥 智能代码应用：支持智能覆盖和诊断修复 ===
    private async _applyCodeToEditor(code: string, diagnosticFix?: any, unitTest?: any) {
        // 情况0：单元测试模式（创建新测试文件）
        if (unitTest) {
            try {
                const sourceUri = vscode.Uri.parse(unitTest.documentUri);
                const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
                const sourcePath = sourceDocument.uri.fsPath;
                
                // 生成测试文件路径（在同一目录下，文件名加 Tests 后缀）
                const dir = path.dirname(sourcePath);
                const fileName = path.basename(sourcePath, path.extname(sourcePath));
                const testFileName = `${fileName}Tests.cs`;
                const testFilePath = path.join(dir, testFileName);
                const testFileUri = vscode.Uri.file(testFilePath);

                // 检查文件是否已存在
                let fileExists = false;
                try {
                    await vscode.workspace.fs.stat(testFileUri);
                    fileExists = true;
                } catch {
                    fileExists = false;
                }

                if (fileExists) {
                    // 文件已存在，询问用户
                    const action = await vscode.window.showWarningMessage(
                        `测试文件 ${testFileName} 已存在，是否覆盖？`,
                        '覆盖',
                        '追加',
                        '取消'
                    );

                    if (action === '取消') {
                        return;
                    }

                    if (action === '覆盖') {
                        // 覆盖文件
                        const encoder = new TextEncoder();
                        await vscode.workspace.fs.writeFile(testFileUri, encoder.encode(code));
                        const doc = await vscode.workspace.openTextDocument(testFileUri);
                        await vscode.window.showTextDocument(doc);
                        vscode.window.showInformationMessage(`✅ 测试文件 ${testFileName} 已覆盖`);
                    } else if (action === '追加') {
                        // 追加到文件末尾
                        const existingDoc = await vscode.workspace.openTextDocument(testFileUri);
                        const existingText = existingDoc.getText();
                        const newText = existingText + '\n\n' + code;
                        const encoder = new TextEncoder();
                        await vscode.workspace.fs.writeFile(testFileUri, encoder.encode(newText));
                        const doc = await vscode.workspace.openTextDocument(testFileUri);
                        await vscode.window.showTextDocument(doc);
                        vscode.window.showInformationMessage(`✅ 测试代码已追加到 ${testFileName}`);
                    }
                } else {
                    // 创建新文件
                    const encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(testFileUri, encoder.encode(code));
                    const doc = await vscode.workspace.openTextDocument(testFileUri);
                    await vscode.window.showTextDocument(doc);
                    vscode.window.showInformationMessage(`✅ 测试文件 ${testFileName} 已创建`);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`创建测试文件失败: ${error.message}`);
            }
            return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('请先打开一个编辑器');
            return;
        }

        const document = editor.document;
        const fullText = document.getText();

        // 情况1：诊断修复模式（最精确的替换）
        if (diagnosticFix) {
            try {
                const targetUri = vscode.Uri.parse(diagnosticFix.documentUri);
                const targetDocument = await vscode.workspace.openTextDocument(targetUri);
                const range = new vscode.Range(
                    new vscode.Position(
                        diagnosticFix.range.start.line,
                        diagnosticFix.range.start.character
                    ),
                    new vscode.Position(
                        diagnosticFix.range.end.line,
                        diagnosticFix.range.end.character
                    )
                );

                // 打开目标文档并应用修复
                await vscode.window.showTextDocument(targetDocument);
                const targetEditor = vscode.window.activeTextEditor;
                if (targetEditor) {
                    // 计算缩进（保持原代码的缩进）
                    const originalLine = targetDocument.lineAt(range.start.line);
                    const leadingWhitespace = originalLine.text.match(/^\s*/)?.[0] || '';
                    const fixedCode = this._preserveIndentation(code, leadingWhitespace);

                    await targetEditor.edit(builder => {
                        builder.replace(range, fixedCode);
                    });

                    // 跳转到修复位置
                    targetEditor.selection = new vscode.Selection(range.start, range.start);
                    targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);

                    vscode.window.showInformationMessage('✅ 诊断错误已修复');
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`应用修复失败: ${error.message}`);
                // 降级到普通应用模式
                this._applyCodeToEditor(code);
            }
            return;
        }

        // 情况1：用户选中了代码，直接替换选中区域
        if (!editor.selection.isEmpty) {
            await editor.edit(builder => {
                builder.replace(editor.selection, code);
            });
            vscode.window.showInformationMessage('✅ 代码已应用到选中区域');
            return;
        }

        // 情况2：智能匹配和替换
        // 尝试识别代码类型（类、方法、完整文件等）
        const codeType = this._detectCodeType(code);
        
        let targetRange: vscode.Range | null = null;

        switch (codeType.type) {
            case 'class':
                // 查找类定义并替换整个类
                if (codeType.name) {
                    targetRange = this._findClassRange(document, codeType.name);
                }
                break;
            case 'method':
                // 查找方法定义并替换方法体
                if (codeType.name) {
                    targetRange = this._findMethodRange(document, codeType.name);
                }
                break;
            case 'full_file':
                // 完整文件，替换整个文档
                targetRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(fullText.length)
                );
                break;
        }

        if (targetRange) {
            // 显示预览并确认
            const preview = document.getText(targetRange);
            const action = await vscode.window.showInformationMessage(
                `检测到 ${codeType.type === 'class' ? '类' : codeType.type === 'method' ? '方法' : '完整文件'}，是否替换？`,
                '替换',
                '取消',
                '查看差异'
            );

            if (action === '替换') {
                await editor.edit(builder => {
                    builder.replace(targetRange!, code);
                });
                vscode.window.showInformationMessage('✅ 代码已智能替换');
            } else if (action === '查看差异') {
                // 打开差异视图（需要创建临时文件）
                await this._showDiff(preview, code, codeType.name || '代码');
            }
        } else {
            // 无法智能匹配，提供选项
            const action = await vscode.window.showInformationMessage(
                '无法自动匹配代码位置，请选择操作：',
                '插入到光标位置',
                '替换整个文件',
                '取消'
            );

            if (action === '插入到光标位置') {
                await editor.edit(builder => {
                    builder.insert(editor.selection.active, code);
                });
            } else if (action === '替换整个文件') {
                const confirm = await vscode.window.showWarningMessage(
                    '确定要替换整个文件吗？此操作不可撤销。',
                    '确定',
                    '取消'
                );
                if (confirm === '确定') {
                    await editor.edit(builder => {
                        const fullRange = new vscode.Range(
                            document.positionAt(0),
                            document.positionAt(fullText.length)
                        );
                        builder.replace(fullRange, code);
                    });
                    vscode.window.showInformationMessage('✅ 文件已替换');
                }
            }
        }
    }

    // 检测代码类型
    private _detectCodeType(code: string): { type: 'class' | 'method' | 'full_file' | 'unknown', name?: string } {
        const trimmedCode = code.trim();
        
        // 检测完整文件（包含 using、namespace、class 等）
        if (trimmedCode.includes('using ') && (trimmedCode.includes('namespace ') || trimmedCode.includes('class '))) {
            return { type: 'full_file', name: undefined };
        }

        // 检测类定义（更精确的正则）
        const classMatch = trimmedCode.match(/\b(public\s+|private\s+|protected\s+|internal\s+)?(static\s+)?(sealed\s+)?(abstract\s+)?class\s+(\w+)/);
        if (classMatch) {
            return { type: 'class', name: classMatch[5] };
        }

        // 检测方法定义（C# 方法通常有访问修饰符和返回类型）
        // 匹配模式：访问修饰符 [static] [async] 返回类型 方法名(参数)
        const methodMatch = trimmedCode.match(/\b(public|private|protected|internal)\s+(static\s+)?(async\s+)?(\w+\s+)?(\w+)\s*\(/);
        if (methodMatch && !trimmedCode.includes('class ') && !trimmedCode.includes('namespace ')) {
            return { type: 'method', name: methodMatch[5] };
        }

        // 检测 Main 方法（特殊处理）
        if (trimmedCode.includes('static void Main') || trimmedCode.includes('static int Main')) {
            return { type: 'method', name: 'Main' };
        }

        return { type: 'unknown' };
    }

    // 查找类定义的范围
    private _findClassRange(document: vscode.TextDocument, className: string): vscode.Range | null {
        const text = document.getText();
        // 更精确的类匹配：匹配 class ClassName 后面可能跟 : 或 {
        const classRegex = new RegExp(`\\b(public\\s+|private\\s+|protected\\s+|internal\\s+)?(static\\s+)?(sealed\\s+)?(abstract\\s+)?class\\s+${className}\\b`);
        const match = text.match(classRegex);
        
        if (!match || match.index === undefined) {
            return null;
        }

        // 找到类定义的开始位置（class 关键字）
        const classStartIndex = match.index;
        const startPos = document.positionAt(classStartIndex);
        
        // 从类名后开始查找第一个 {，然后匹配大括号
        let braceCount = 0;
        let foundStartBrace = false;
        let endIndex = classStartIndex;
        let inString = false;
        let stringChar = '';

        for (let i = classStartIndex; i < text.length; i++) {
            const char = text[i];
            const prevChar = i > 0 ? text[i - 1] : '';

            // 处理字符串（忽略字符串内的大括号）
            if (!inString && (char === '"' || char === "'")) {
                inString = true;
                stringChar = char;
            } else if (inString && char === stringChar && prevChar !== '\\') {
                inString = false;
            }

            if (!inString) {
                if (char === '{') {
                    if (!foundStartBrace) {
                        foundStartBrace = true;
                        endIndex = i + 1;
                    }
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (foundStartBrace && braceCount === 0) {
                        endIndex = i + 1;
                        break;
                    }
                }
            }
        }

        if (!foundStartBrace) {
            return null; // 没找到类的大括号
        }

        const endPos = document.positionAt(endIndex);
        return new vscode.Range(startPos, endPos);
    }

    // 查找方法定义的范围
    private _findMethodRange(document: vscode.TextDocument, methodName: string): vscode.Range | null {
        const text = document.getText();
        // 更精确的方法匹配：访问修饰符 [static] [async] 返回类型 方法名(参数)
        const methodRegex = new RegExp(`\\b(public|private|protected|internal)\\s+(static\\s+)?(async\\s+)?(\\w+\\s+)?${methodName}\\s*\\([^)]*\\)\\s*{?`, 'g');
        let match: RegExpExecArray | null;
        
        while ((match = methodRegex.exec(text)) !== null) {
            const startIndex = match.index;
            const startPos = document.positionAt(startIndex);
            
            // 从方法签名后开始查找方法体
            // 找到方法签名的结束位置（通常是 ) 或 {）
            let methodSignatureEnd = startIndex + match[0].length;
            while (methodSignatureEnd < text.length && text[methodSignatureEnd] !== '{' && text[methodSignatureEnd] !== ';') {
                methodSignatureEnd++;
            }

            // 如果是抽象方法或接口方法（以 ; 结尾），跳过
            if (text[methodSignatureEnd] === ';') {
                continue;
            }

            // 从第一个 { 开始匹配大括号
            let braceCount = 0;
            let foundStartBrace = false;
            let endIndex = methodSignatureEnd;
            let inString = false;
            let stringChar = '';

            for (let i = methodSignatureEnd; i < text.length; i++) {
                const char = text[i];
                const prevChar = i > 0 ? text[i - 1] : '';

                // 处理字符串
                if (!inString && (char === '"' || char === "'")) {
                    inString = true;
                    stringChar = char;
                } else if (inString && char === stringChar && prevChar !== '\\') {
                    inString = false;
                }

                if (!inString) {
                    if (char === '{') {
                        if (!foundStartBrace) {
                            foundStartBrace = true;
                            endIndex = i + 1;
                        }
                        braceCount++;
                    } else if (char === '}') {
                        braceCount--;
                        if (foundStartBrace && braceCount === 0) {
                            endIndex = i + 1;
                            break;
                        }
                    }
                }
            }

            if (foundStartBrace) {
                const endPos = document.positionAt(endIndex);
                return new vscode.Range(startPos, endPos);
            }
        }

        return null;
    }

    // 保留缩进辅助方法
    private _preserveIndentation(code: string, baseIndent: string): string {
        const lines = code.split('\n');
        if (lines.length <= 1) {
            // 单行代码，直接加上基础缩进
            return baseIndent + code.trim();
        }

        // 多行代码：第一行加基础缩进，其他行保持相对缩进
        const result = lines.map((line, index) => {
            if (index === 0) {
                return baseIndent + line.trimStart();
            }
            // 计算相对缩进（保留代码块内部的缩进结构）
            const relativeIndent = line.match(/^\s*/)?.[0] || '';
            return baseIndent + relativeIndent + line.trimStart();
        });

        return result.join('\n');
    }

    // 显示差异视图
    private async _showDiff(oldCode: string, newCode: string, label: string) {
        try {
            // 生成唯一的 URI（使用时间戳避免冲突）
            const timestamp = Date.now();
            const sanitizedLabel = label.replace(/[^a-zA-Z0-9]/g, '_');
            const oldUri = vscode.Uri.parse(`smartcoder-diff:old-${sanitizedLabel}-${timestamp}.cs`);
            const newUri = vscode.Uri.parse(`smartcoder-diff:new-${sanitizedLabel}-${timestamp}.cs`);

            // 更新内容提供者的内容
            this._diffProvider.updateContent(oldUri, oldCode);
            this._diffProvider.updateContent(newUri, newCode);

            // 打开差异视图
            await vscode.commands.executeCommand(
                'vscode.diff',
                oldUri,
                newUri,
                `${label} (原代码) ↔ ${label} (新代码)`
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(`打开差异视图失败: ${error.message}`);
        }
    }

    // === 前端 HTML (增加了顶部刷题栏) ===
    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: var(--vscode-font-family); padding: 0; margin: 0; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
                
                /* 🔥 顶部刷题工具栏 */
                .toolbar {
                    padding: 10px;
                    background: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-widget-border);
                    display: flex; gap: 6px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                }
                #problemInput {
                    flex: 1;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 4px 8px; border-radius: 3px; outline: none;
                    font-size: 12px;
                }
                #problemInput:focus { border-color: var(--vscode-focusBorder); }
                #loadProblemBtn {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; font-size: 12px;
                    display: flex; align-items: center; justify-content: center;
                }
                #loadProblemBtn:hover { background: var(--vscode-button-hoverBackground); }

                /* ✨ 模型切换区域样式 */
                .model-switch {
                    padding: 10px;
                    background: var(--vscode-textBlockQuote-background);
                    border-bottom: 1px solid var(--vscode-widget-border);
                    font-size: 12px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }

                /* 🔥 云端状态栏 */
                .cloud-status {
                    background: var(--vscode-textBlockQuote-background);
                    padding: 10px;
                    border-left: 3px solid #0078d4;
                    margin: 10px;
                    font-size: 12px;
                    border-radius: 4px;
                }

                .chat-container { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 15px; }
                .message { padding: 12px; border-radius: 6px; font-size: 13px; line-height: 1.5; max-width: 100%; word-wrap: break-word; }
                .user { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); align-self: flex-end; max-width: 85%; }
                .ai { background: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; width: 95%; }
                .system { background: var(--vscode-textBlockQuote-background); border-left: 3px solid #0078d4; align-self: center; max-width: 90%; font-size: 12px; }

                .context-chip { display: none; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-activeForeground); padding: 8px 12px; margin: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); border-radius: 4px; cursor: pointer; }
                .user-code-preview { background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; font-family: 'Consolas', monospace; font-size: 11px; margin-bottom: 8px; border-left: 2px solid rgba(255,255,255,0.3); white-space: pre-wrap; color: var(--vscode-textPreformat-foreground); }
                
                .code-box { margin-top: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; background: var(--vscode-textBlockQuote-background); }
                .code-header { display: flex; justify-content: space-between; align-items: center; padding: 5px 10px; background: rgba(0,0,0,0.1); border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; }
                .code-content { padding: 10px; overflow-x: auto; font-family: 'Consolas', monospace; font-size: 12px; white-space: pre; }
                .apply-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; }

                .input-area { padding: 15px; background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-widget-border); }
                textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: none; height: 50px; padding: 8px; border-radius: 4px; outline: none; box-sizing: border-box; font-family: inherit; }
                .send-row { display: flex; justify-content: flex-end; margin-top: 8px; }
                #sendBtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 15px; border-radius: 3px; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="toolbar">
                <input type="text" id="problemInput" placeholder="输入题目名称 或 洛谷URL..." />
                <button id="loadProblemBtn" title="加载题目">📥 加载</button>
            </div>

            <div class="model-switch">
                <input type="checkbox" id="useLocalModel">
                <label for="useLocalModel">使用本地 Ollama (qwen2.5)</label>
            </div>

            <!-- 🔥 云端状态栏 -->
            <div id="cloudStatus" class="cloud-status" style="display: none;">
                <strong>☁️ 云端协同模式</strong><br>
                题目: <span id="pTitle">无</span> | ID: <span id="pId">-</span>
            </div>

            <div class="chat-container" id="chat"></div>
            <div id="contextChip" class="context-chip" onclick="clearContext()"></div>

            <div class="input-area">
                <textarea id="msgInput" placeholder="输入问题... (Ctrl+Enter发送)"></textarea>
                <div class="send-row">
                    <button id="submitCloudBtn" style="display: none; margin-right: 8px; background: var(--vscode-button-secondaryBackground);">☁️ 提交到网页端</button>
                    <button id="sendBtn">发送</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const chatDiv = document.getElementById('chat');
                const msgInput = document.getElementById('msgInput');
                const contextChip = document.getElementById('contextChip');
                const useLocalModelCheckbox = document.getElementById('useLocalModel');
                let currentCodeContext = null;

                // 监听顶部加载按钮
                document.getElementById('loadProblemBtn').addEventListener('click', () => {
                    const val = document.getElementById('problemInput').value;
                    if(val.trim()) {
                        vscode.postMessage({ type: 'loadProblem', value: val.trim() });
                    }
                });

                // 🔥 云端提交按钮点击事件
                document.getElementById('submitCloudBtn').addEventListener('click', () => {
                    vscode.postMessage({ type: 'submitToCloud' });
                });

                window.addEventListener('message', event => {
                    const msg = event.data;
                    switch (msg.type) {
                        case 'setCloudMode':
                            // 🔥 显示云端模式
                            document.getElementById('cloudStatus').style.display = 'block';
                            document.getElementById('pTitle').innerText = msg.title || '未知';
                            document.getElementById('pId').innerText = msg.id || '-';
                            document.getElementById('submitCloudBtn').style.display = 'inline-block';
                            addMessage('system', { text: '✅ 已连接云端，请开始解题！' });
                            break;
                        case 'setCodeContext':
                            currentCodeContext = msg.value;
                            updateContextChip();
                            msgInput.focus();
                            break;
                        case 'addUserMessage': 
                            addMessage('user', { text: msg.value });
                            break;
                        case 'addAiMessage':
                            document.getElementById('loading')?.remove();
                            addMessage('ai', msg.data);
                            break;
                        case 'showLoading':
                            const div = document.createElement('div');
                            div.id = 'loading';
                            div.className = 'message ai';
                            div.innerText = '⚡ 思考中...';
                            chatDiv.appendChild(div);
                            break;
                    }
                });

                function updateContextChip() {
                    if (currentCodeContext) {
                        const lines = currentCodeContext.split('\\n');
                        const preview = lines.length > 1 ? lines[0].trim() + '...' : lines[0].trim();
                        contextChip.style.display = 'block';
                        contextChip.innerText = '📄 已引用: ' + preview.substring(0, 30) + (preview.length>30?'...':'') + ' (点击取消)';
                    } else {
                        contextChip.style.display = 'none';
                    }
                }

                function sendMessage() {
                    const text = msgInput.value;
                    // ✨ 获取是否使用本地模型
                    const useLocal = useLocalModelCheckbox.checked;
                    
                    if (!text && !currentCodeContext) return;
                    addMessage('user', { text: text || "请分析", codeContext: currentCodeContext });
                    // ✨ 发送消息时带上 useLocalModel 参数
                    vscode.postMessage({ 
                        type: 'askAI', 
                        value: text || "请分析", 
                        codeContext: currentCodeContext,
                        useLocalModel: useLocal  // 告诉后端使用什么模型
                    });
                    msgInput.value = '';
                    clearContext();
                }

                function clearContext() { currentCodeContext = null; updateContextChip(); }
                document.getElementById('sendBtn').addEventListener('click', sendMessage);
                msgInput.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') sendMessage(); });

                function addMessage(role, data) {
                    const div = document.createElement('div');
                    div.className = 'message ' + role;
                    if (role === 'user') {
                        let html = '';
                        if (data.codeContext) {
                            const lines = data.codeContext.split('\\n');
                            let previewCode = lines.length <= 3 ? data.codeContext : lines.slice(0, 3).join('\\n') + '\\n... (共 ' + lines.length + ' 行)';
                            html += \`<div class="user-code-preview">\${previewCode.replace(/</g, '&lt;')}</div>\`;
                        }
                        html += \`<div>\${data.text ? data.text.replace(/</g, '&lt;') : ''}</div>\`;
                        div.innerHTML = html;
                    } else if (role === 'system') {
                        div.innerHTML = \`<div>\${data.text ? data.text.replace(/</g, '&lt;').replace(/\\n/g, "<br>") : ''}</div>\`;
                    } else {
                        let html = '<div>' + (data.analysis || '').replace(/</g, "&lt;").replace(/\\n/g, "<br>").replace(/\\*\\*(.*?)\\*\\*/g, "<b>$1</b>") + '</div>';
                        if (data.code && data.code.trim() !== "null") {
                            const codeB64 = btoa(unescape(encodeURIComponent(data.code))); 
                            let fixLabel = 'C# Template/Fix';
                            let fixInfo = '';
                            let unitTestInfo = '';
                            
                            if (data._diagnosticFix) {
                                fixLabel = '🔧 修复诊断错误';
                                fixInfo = JSON.stringify(data._diagnosticFix);
                            } else if (data._unitTest) {
                                fixLabel = '🧪 单元测试代码';
                                unitTestInfo = JSON.stringify(data._unitTest);
                            }
                            
                            const fixInfoB64 = fixInfo ? btoa(unescape(encodeURIComponent(fixInfo))) : '';
                            const unitTestInfoB64 = unitTestInfo ? btoa(unescape(encodeURIComponent(unitTestInfo))) : '';
                            html += \`<div class="code-box"><div class="code-header"><span>\${fixLabel}</span><button class="apply-btn" onclick="applyCode('\${codeB64}', '\${fixInfoB64}', '\${unitTestInfoB64}')">⚡ 应用</button></div><div class="code-content">\${data.code.replace(/</g, "&lt;")}</div></div>\`;
                        }
                        div.innerHTML = html;
                    }
                    chatDiv.appendChild(div);
                    window.scrollTo(0, document.body.scrollHeight);
                }

                window.applyCode = (b64, fixInfoB64, unitTestInfoB64) => {
                    const code = decodeURIComponent(escape(atob(b64)));
                    const message = { type: 'applyCode', value: code };
                    if (fixInfoB64) {
                        try {
                            const fixInfo = JSON.parse(decodeURIComponent(escape(atob(fixInfoB64))));
                            message.diagnosticFix = fixInfo;
                        } catch (e) {
                            console.error('Failed to parse diagnostic fix info', e);
                        }
                    }
                    if (unitTestInfoB64) {
                        try {
                            const unitTestInfo = JSON.parse(decodeURIComponent(escape(atob(unitTestInfoB64))));
                            message.unitTest = unitTestInfo;
                        } catch (e) {
                            console.error('Failed to parse unit test info', e);
                        }
                    }
                    vscode.postMessage(message);
                };
            </script>
        </body>
        </html>`;
    }
}

export function deactivate() {}