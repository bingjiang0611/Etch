import { describe, expect, it, vi } from 'vitest'
import {
  logChildEnvironmentKeys,
  loginShellEnvironment,
  operationalEnvironment,
  providerEnvironment
} from '../src/main/runtime/shell-env'

describe('login shell environment', () => {
  it('reuses the first successful login-shell result for every pipeline stage', async () => {
    const runner = vi.fn(async () => ({
      pid: 123,
      exitCode: 0,
      signal: null,
      stdout: 'PATH=/opt/homebrew/bin\0CUSTOM_LOGIN_VALUE=ready\0',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false
    }))

    const first = await loginShellEnvironment({ PATH: '/usr/bin', CLAUDECODE: 'nested' }, runner)
    const second = await loginShellEnvironment({ PATH: '/different', CODEX_THREAD_ID: 'nested' }, runner)

    expect(first.PATH).toBe('/opt/homebrew/bin')
    expect(first.CUSTOM_LOGIN_VALUE).toBe('ready')
    expect(first.CLAUDECODE).toBeUndefined()
    expect(second.PATH).toBe('/opt/homebrew/bin')
    expect(second.CODEX_THREAD_ID).toBeUndefined()
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ command: '/bin/zsh', args: ['-lc', 'env -0'], timeoutMs: 5_000 }))
  })

  it('keeps operational necessities while dropping ambient credentials and injection variables', () => {
    const env = operationalEnvironment({
      PATH: '/tools',
      HOME: '/home/test',
      TMPDIR: '/tmp/test',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/config',
      HTTPS_PROXY: 'https://proxy.invalid',
      NODE_EXTRA_CA_CERTS: '/cert.pem',
      SSH_AUTH_SOCK: '/agent.sock',
      OPENAI_API_KEY: 'openai-canary',
      ANTHROPIC_API_KEY: 'anthropic-canary',
      AWS_SECRET_ACCESS_KEY: 'aws-canary',
      GH_TOKEN: 'github-canary',
      NODE_OPTIONS: '--require /tmp/inject.cjs'
    })

    expect(env).toMatchObject({
      PATH: '/tools',
      HOME: '/home/test',
      TMPDIR: '/tmp/test',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/config',
      HTTPS_PROXY: 'https://proxy.invalid',
      NODE_EXTRA_CA_CERTS: '/cert.pem',
      SSH_AUTH_SOCK: '/agent.sock'
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('passes only each provider adapter credentials on top of the operational environment', () => {
    const full = {
      PATH: '/tools',
      HOME: '/home/test',
      OPENAI_API_KEY: 'openai-canary',
      CODEX_HOME: '/codex',
      ANTHROPIC_API_KEY: 'anthropic-canary',
      AWS_PROFILE: 'bedrock',
      GOOGLE_APPLICATION_CREDENTIALS: '/google.json',
      QODER_TOKEN: 'qoder-canary',
      OPENCODE_CONFIG: '/opencode.json',
      OPENROUTER_API_KEY: 'router-canary',
      GH_TOKEN: 'github-canary'
    }

    expect(providerEnvironment('codex', full)).toMatchObject({
      PATH: '/tools',
      HOME: '/home/test',
      OPENAI_API_KEY: 'openai-canary',
      CODEX_HOME: '/codex'
    })
    expect(providerEnvironment('codex', full).ANTHROPIC_API_KEY).toBeUndefined()
    expect(providerEnvironment('claude', full)).toMatchObject({
      ANTHROPIC_API_KEY: 'anthropic-canary',
      AWS_PROFILE: 'bedrock',
      GOOGLE_APPLICATION_CREDENTIALS: '/google.json'
    })
    expect(providerEnvironment('qoder', full).QODER_TOKEN).toBe('qoder-canary')
    expect(providerEnvironment('qoder', full).OPENAI_API_KEY).toBeUndefined()
    expect(providerEnvironment('opencode', full)).toMatchObject({
      OPENCODE_CONFIG: '/opencode.json',
      OPENAI_API_KEY: 'openai-canary',
      ANTHROPIC_API_KEY: 'anthropic-canary',
      OPENROUTER_API_KEY: 'router-canary'
    })
    expect(providerEnvironment('opencode', full).GH_TOKEN).toBeUndefined()
  })

  it('supports an explicit legacy escape hatch without restoring nested-agent pollution', () => {
    const env = providerEnvironment('codex', {
      PATH: '/tools',
      ETCH_LEGACY_FULL_CHILD_ENV: '1',
      GH_TOKEN: 'legacy-canary',
      CLAUDECODE: 'nested',
      CODEX_THREAD_ID: 'nested'
    })

    expect(env.GH_TOKEN).toBe('legacy-canary')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CODEX_THREAD_ID).toBeUndefined()
  })

  it.each([
    ['claude', 'CLAUDE_CODE_ENTRYPOINT'],
    ['codex', 'CODEX_THREAD_ID'],
    ['qoder', 'QODER_SESSION_ID'],
    ['opencode', 'OPENCODE_SERVER']
  ] as const)('removes %s nested-agent pollution at the provider boundary', (provider, pollutedKey) => {
    const env = providerEnvironment(provider, {
      PATH: '/tools',
      [pollutedKey]: 'nested-agent-canary'
    })

    expect(env[pollutedKey]).toBeUndefined()
  })

  it('skips login-shell discovery in hermetic E2E mode', async () => {
    const runner = vi.fn()
    const env = await loginShellEnvironment({ PATH: '/fake', ETCH_E2E_HERMETIC: '1' }, runner)
    expect(env.PATH).toBe('/fake')
    expect(runner).not.toHaveBeenCalled()
  })

  it('logs sorted environment key names once without logging values', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    logChildEnvironmentKeys('test:canary-scope', { Z_KEY: 'secret-canary', A_KEY: 'other-secret' })
    logChildEnvironmentKeys('test:canary-scope', { EXTRA: 'must-not-log' })

    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[0]).toContain('A_KEY,Z_KEY')
    expect(info.mock.calls[0]?.[0]).not.toContain('secret-canary')
    expect(info.mock.calls[0]?.[0]).not.toContain('other-secret')
    info.mockRestore()
  })
})
