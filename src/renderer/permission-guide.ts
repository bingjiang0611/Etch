import type { ChromeCookieAccess } from '../shared/ipc'

export interface PermissionGuideCopy {
  eyebrow: string
  title: string
  body: string
  secondary: string
  steps: string[]
}

export function permissionGuideCopy(access: ChromeCookieAccess): PermissionGuideCopy {
  if (access === 'granted') return {
    eyebrow: '授权已生效',
    title: '重启 Etch 即可读取登录状态',
    body: '系统授权已读取成功。macOS 的权限按进程生效，重启后 Etch 即可拿到 Chrome 登录状态，失败的任务可直接重试。',
    secondary: '稍后重启',
    steps: []
  }
  if (access === 'missing') return {
    eyebrow: 'YouTube 登录验证',
    title: '本机未找到 Chrome 登录资料',
    body: '需要登录的 YouTube 视频要靠 Chrome 里的登录状态下载。请先安装 Chrome 并登录 YouTube，再回到 Etch 重试。',
    secondary: '稍后设置',
    steps: []
  }
  return {
    eyebrow: 'YouTube 登录验证',
    title: '允许 Etch 读取 Chrome 登录状态',
    body: '部分 YouTube 视频需要登录后才能下载。macOS 把 Chrome 的登录状态归入受保护数据，需要先为 Etch 开启“完全磁盘访问”。',
    secondary: '稍后设置',
    steps: [
      '点击下方按钮，打开“系统设置 → 隐私与安全性 → 完全磁盘访问”。',
      '点击加号添加 Etch，并打开右侧开关。',
      '回到本窗口，Etch 会自动识别授权并提示重启。'
    ]
  }
}
