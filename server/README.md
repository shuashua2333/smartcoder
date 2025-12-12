# SmartCoder 后端服务器

## 安装依赖

```bash
npm install
```

## 启动服务器

```bash
npm start
```

或者

```bash
node server.js
```

服务器将在 http://localhost:3000 启动。

## API 端点

- `POST /api/submit` - 接收来自 VS Code 的代码提交
- `GET /api/check` - 网页端轮询检查新提交
- `POST /api/mark_read` - 标记提交为已读

