# Telomi SRT

Telomi 的唯一 Agent 沙箱模块。它使用 `@anthropic-ai/sandbox-runtime` 执行受限进程，并把 Agent 使用的 guest path 映射到 Runtime 固定的 host mounts。

调用方只使用：

- `SandboxExecutionSpec` 描述 mounts、写入范围、工具和网络策略。
- `SrtWorkspace` 提供受约束的 Pi 文件工具。
- `spawnSrt` / `execSrt` 启动受约束的进程。
- `srt-python.mjs` 作为 Prime 的 Python 启动器，把 Root 和 RLM Child 的 IPython Kernel 放进 SRT。

Prime 的 Controller、Session、凭证和 autonomous loop 运行在 Host。只有模型生成代码的 Kernel 进入 SRT；业务文件的读取限于当前 Worker Workspace 和显式提供的只读输入、Skill 与 SDK，Runtime 私有目录保持拒绝，Kernel 不继承 Provider 凭证。

Pi 与 Prime 共用默认拒绝读取的策略，按声明开放业务目录，并只读开放操作系统工具、运行库和实际 Node/Python 环境。Python 的运行目录从解释器配置解析，不把 `/usr` 等整个安装前缀作为权限。项目内 `.prime-kernel` 的 `bin` 位于 Agent `PATH` 首位；裸 `python` 和 `python3` 使用项目环境。

重叠挂载按实际授权合成：只读父目录不撤销显式可写子目录的权限，可写目录中的只读子目录仍禁止写入。逻辑视图的 shadow 由文件工具检查；同一物理路径已通过另一个挂载明确授权时，shadow 不构成对该路径的全局拒绝。

该边界限制内容访问，不提供独立文件系统命名空间的跨平台保证：主机绝对路径可能仍可见，macOS SRT 保留根目录列举和目录元数据，Linux SRT 使用自己的进程与特殊文件系统隔离规则。权限由操作系统作用于受限进程及其子进程；Host 服务代执行的操作仍须自行检查请求权限。文件权限不代替执行超时。

模块不提供无沙箱 fallback。初始化、策略、网络、文件或进程错误会直接传播。
