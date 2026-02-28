重启（改了 container/ 里的镜像相关内容、明确要切换/重建 Apple Container 运行时镜像）

```bash
npx tsx setup/index.ts --step container -- --runtime apple-container
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

否则：

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```