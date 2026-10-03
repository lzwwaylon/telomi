# 配置 Tailscale 转发

[English](network-egress.md) | 简体中文

本地路由不可用时，可以让符合条件的 arXiv 请求使用另一台电脑的网络连接。Telomi 仍保留统一排队和重试限制；增加节点不能保证上游请求一定成功。

## 准备电脑

1. 在运行 Telomi 的电脑和每台转发电脑上安装 [Tailscale](https://tailscale.com/download)，登录同一个 tailnet，或授予必要的 tailnet 访问权限。Telomi 读取本机 Tailscale 客户端，仅在浏览器中登录并不足以建立连接。
2. 在 Linux 或 macOS 转发电脑上启用 SSH 服务。SSH 账号需要支持密钥认证，并允许 TCP 转发。SSH 用户名可以与 Tailscale 登录账号不同。
3. 从运行 Telomi 的电脑执行一次 `ssh 用户名@TAILSCALE_IP`，核对主机身份后再信任其密钥。确认后续连接无需密码或交互提示即可成功。Tailnet 访问规则和 SSH 服务都需要允许连接。

Telomi 与 Research Source Service 必须运行在同一台电脑上。转发电脑只需要 Tailscale 和 SSH，无需另装 Telomi 或 Source Service。iPhone 会出现在设备列表中，但这种转发方式要求电脑提供 SSH 服务。

## 配置 Telomi

1. 打开设置 > 网络出口。若 Tailscale 未安装或未连接，按页面提示安装或登录。已经连接的客户端会保留现有网络偏好。
2. 刷新设备列表，选择转发电脑，填写 SSH 用户名和端口，通常为 `22`，并启用转发。
3. 保存配置，等待节点显示就绪。设备在线不代表 SSH 转发已经可用。

Telomi 自动管理转发进程及其本地端口，无需填写代理 URL、固定本地端口、私钥或密码。节点选择保存在当前安装中，重启 Telomi 后会恢复。

## 核查与排错

- 当前 arXiv 路由受限时，就绪节点可以承接符合条件的重试。请求仍遵循统一队列与冷却时间。
- 遇到认证或主机信任错误，请使用运行 Telomi 的同一台电脑、同一个系统账号核查普通 SSH 连接。Telomi 不会自动信任未知主机密钥。
- 节点离线时，检查 Tailscale 连接和转发电脑是否休眠。连接失败的隧道会在定期刷新时重试。
- Source Service 不可用时，恢复本地服务后刷新。部署在远程的 Source Service 无法访问 Telomi 的本机转发端口。
- 不再使用某个节点时，取消选择并保存。关闭转发会移除全部托管节点，单独配置的静态路由会保留。

关闭或重启 Telomi 会关闭它管理的 SSH 进程。禁用节点时，会等待该节点正在处理的 Source 请求结束后再关闭隧道。
