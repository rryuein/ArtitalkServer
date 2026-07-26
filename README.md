# Artitalk Vercel 服务端

这个目录用于部署 [Artitalk](https://github.com/HCLonely/Artitalk) 的 Vercel 服务端，用 Neon Postgres 替代即将下线的 LeanCloud 服务。

## 环境变量

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 初始化管理员时必填 | 初始化页面注册第一个管理员账号时使用的用户名。数据库已有管理员后不会再创建。 |
| `ADMIN_PASSWORD` | 初始化管理员时必填 | 初始化页面注册第一个管理员账号时使用的密码。 |
| `ADMIN_IMG` | 否 | 管理员头像 URL。 |
| `ADMIN_IMG_Token` | 否 | [S.EE](https://s.ee/) 图床上传 Token，不配置无法使用文件上传功能。 |
| `ALLOW_ORIGIN` | 否 | 限制允许跨域访问的站点域名，多个域名用英文逗号分隔，例如 `https://blog.example.com,https://admin.example.com`。未配置时允许所有域名访问。 |

## Vercel 连接 Neon

推荐在 Vercel Storage 安装 Neon Postgres，并把数据库连接到当前 Vercel 项目：

1. 在 Vercel Dashboard 打开 Storage，安装 `Neon` / `Neon Postgres` 集成。
2. 如果还没有 Neon 账号或希望账单由 Vercel 管理，选择创建新的 Neon 账号；如果已有 Neon 项目，选择连接现有 Neon 账号。
3. 在 Vercel 的 Storage 页面选择刚创建或已连接的 Neon 数据库，进入 `Connect Project`。
4. 选择部署本服务端的 Vercel Project，并勾选需要注入数据库变量的环境：Production。
5. 在 `Custom Prefix` 下面填写 `ARTITALK`。
6. 连接后，Vercel 会给自动项目写入数据库变量。

也可以不安装集成，直接在 Neon Console 复制 pooled connection string，然后在 Vercel 项目里手动添加 `ARTITALK_DATABASE_URL` 环境变量。

## 本地命令

```bash
npm install
npm test
```

## 初始化页面

部署到 Vercel 后，访问站点根路径。如果数据库中没有 Artitalk 数据，页面会显示两个选项：

- `初始化数据库`：只创建数据库表结构。
- `从 LeanCloud 迁移`：在浏览器中上传 `shuoshuo.0.jsonl` 和 `atComment.0.jsonl`，然后导入数据库。

迁移会导入 `shuoshuo` 和 `atComment` 两类 JSONL 导出数据。

## 客户端配置

部署这个目录后，在 Artitalk 配置中把部署地址填为 `serverURL`，并启用 Vercel 后端：

```js
new Artitalk({
  backend: 'vercel',
  serverURL: 'https://your-vercel-app.vercel.app'
})
```
