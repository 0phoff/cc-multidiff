// Editors the pane can open a folder or file in.

export type Editor = { cli: string; name: string; args: string[] }
export const VSCODE: Editor = { cli: 'code', name: 'VS Code', args: ['-n'] }
// -n opens a new window; without it both editors reuse the one that is already up.
export const ZED: Editor = { cli: 'zed', name: 'Zed', args: ['-n'] }

export async function openIn($: any, editor: Editor, path: string) {
  try {
    const out = await $.process.run([editor.cli, ...editor.args, path])
    if (out.exitCode === 0) return
    await $.ui.toast(`${editor.name}: ${out.stderr.trim() || `exit ${out.exitCode}`}`)
  } catch {
    await $.ui.toast(`${editor.name}: \`${editor.cli}\` not found on the PATH`)
  }
}
