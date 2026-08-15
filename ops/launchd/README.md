# 排程自動更新

```bash
cp ops/launchd/com.tokyo-rent.crawl.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tokyo-rent.crawl.plist
launchctl kickstart -p gui/$(id -u)/com.tokyo-rent.crawl   # 立刻跑一次確認
```

停用：

```bash
launchctl bootout gui/$(id -u)/com.tokyo-rent.crawl
```

**plist 範本進 git，實際安裝的那份不進**——裡面有絕對路徑，換機器就不對了。
重新產生範本：重跑本專案的 setup 或手動改 `ProgramArguments` 與 `WorkingDirectory`。

抓取完成後仍需人工執行：

```bash
npm run build:data   # 產生網站資料（含驗證閘門）
git add -A && git commit && git push   # 觸發 GitHub Pages 重新部署
```

刻意不自動 commit/push——資料變動應該有人看過 `git diff` 再送出。
