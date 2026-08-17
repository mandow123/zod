# 产品经理代码审计记录

每次提交前，由唯一 App 产品经理审阅暂存差异。批准记录使用独立 JSON 文件，至少包含：

```json
{
  "schemaVersion": 1,
  "auditId": "PM-YYYYMMDD-NNN",
  "auditor": "App product manager",
  "decision": "APPROVED",
  "auditedAt": "ISO-8601 时间",
  "baseCommit": "审计时的 HEAD",
  "stagedDiffSha256": "不含审计记录目录的暂存差异 SHA-256",
  "summary": "产品经理的审计结论"
}
```

`baseCommit` 和 `stagedDiffSha256` 必须与提交瞬间完全一致，否则提交门禁拒绝通过。门禁只读取 Git
暂存区中的审计记录，不读取工作区文件；GitLab CI 会在提交后再次验证同一记录。
