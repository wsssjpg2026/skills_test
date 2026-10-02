# plugins/ — 运行时插件清单目录（dev）

内核启动时从本目录（`orch.config.json` → `plugins.dir`）发现驱动插件清单并
交给 `@orch/plugin-host` 拉起子进程（架构文档 §6.1）。插件宿主随工单 #3 接入。

清单格式 `plugins/<id>/plugin.json`：

```json
{
  "id": "driver-modbus",
  "language": "node",
  "command": "node",
  "args": ["../packages/drivers/modbus/dist/main.js"]
}
```

Python 插件：`{"language": "python", "command": "python3",
"args": ["-m", "orch_plugin_sdk.cli", "sidecar.py"]}`。

清单是运行时配置，包本体位于 `packages/drivers/*`（npm workspaces）。

当前已随仓库发布：

- `plugins/mock-driver/plugin.json` —— `@orch/mock-driver`（工单 #3），可脚本化的
  参考驱动插件；channel `config` 按 §5.2 写脚本（`{script:[{afterMs,set|quality|…}]}`），
  能力位为 `write` / `read_on_demand` / `validate`（无 `subscribe`，宿主以轮询 `read`
  模拟订阅）。
