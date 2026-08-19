# 发布流程（第一次发布 / 后续自动发布）

本文记录本插件发布到 npm 的完整流程：**GitHub Actions + npm Trusted Publishing（OIDC）自动上传**。

## 一、发布前准备

### 1. 包名与权限
- 包名：`@lanbaolu/<插件名>`（使用用户 lanbaolu 的 scope）
- 确认登录：
  ```bash
  npm whoami --registry=https://registry.npmjs.org
  # 应输出 lanbaolu
  ```

### 2. package.json 关键配置
```json
{
  "name": "@lanbaolu/dsh-llm-verifier",
  "version": "0.1.0",
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "scripts": {
    "build": "bash scripts/build.sh",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

### 3. GitHub Actions 发布配置
创建 `.github/workflows/publish.yml`：
```yaml
name: publish
on:
  push:
    tags: ['v*']
  workflow_dispatch:
permissions:
  id-token: write
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm publish --provenance --access public
```

### 4. 构建脚本不依赖本地 DSH_CHECKOUT
`scripts/build.sh` 必须能在 CI 独立构建：
```bash
"$TSC" -p tsconfig.json
cp -R bridge/*.py lib/bridge/
```

### 5. 生成纯净 package-lock
本地 node_modules 如果存在指向其他项目的链接，生成的 lock 会带本地路径，导致 CI `npm ci` 失败。在干净状态生成：
```bash
rm -rf node_modules package-lock.json
npm install --package-lock-only --registry=https://registry.npmjs.org
```

---

## 二、首次发布（创建包）

> 首次发布因为包在 npm 上还不存在 + 账号开了 2FA，**必须在本地终端跑一次**，让 npm 弹浏览器授权。

```bash
cd "/Users/odis/Desktop/Deepseek Harness/llm-verifier"
npm publish --registry=https://registry.npmjs.org --access public --provenance=false
```

- 路径**必须加引号**（有空格）
- npm 会弹出浏览器 → 点授权 → 终端显示 `+ @lanbaolu/dsh-llm-verifier@0.1.0` 即成功
- 本地首次发布用 `--provenance=false`（本地没有 OIDC 环境）

---

## 三、配置 Trusted Publisher（一次性）

包发布成功后，在 npm 网页给该包配置 OIDC 信任：

1. 打开包页面：
   ```
   https://www.npmjs.com/package/@lanbaolu/dsh-llm-verifier
   ```
2. 点 **Settings**
3. 找 **Trusted Publisher** → 选 **GitHub Actions**
4. 填写：

| 字段 | 值 |
|---|---|
| Organization or user | `lanbaolu` |
| Repository | `dsh-llm-verifier` |
| Workflow filename | `publish.yml`（**注意别漏了 `l`**） |
| Environment name | 留空 |
| Allowed actions | ✅ **Allow npm publish** |

5. 保存

---

## 四、验证自动发布

打一个新版本 tag 触发 CI：

```bash
npm version 0.1.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.1.0"
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 自动执行：`npm ci → typecheck → build → npm publish --provenance`

验证：
```bash
npm view @lanbaolu/dsh-llm-verifier versions --registry=https://registry.npmjs.org
```

---

## 常见坑

| 坑 | 解决 |
|---|---|
| 路径有空格 cd 失败 | 路径加双引号 |
| 本地 publish 报 provenance 不支持 | 加 `--provenance=false` |
| CI publish 404 | Trusted Publisher 没配 / workflow 名写错 |
| CI publish “不能覆盖已发布版本” | 说明认证通了，升级版本号 |
| 首次生成 token 没权限 | token 必须给 `@lanbaolu` scope **Read and write** |
| 包还没发布就找不到 Trusted Publisher | 先手动发布一次创建包，再配置 |
