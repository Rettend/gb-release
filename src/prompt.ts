import type { ReleasePrompt } from './types.js'
import { confirm, isCancel, select, text } from '@clack/prompts'
import { valid } from 'semver'
import { ReleaseError } from './errors.js'
import { versionChoices } from './version.js'

function cancelled(): never {
  throw new ReleaseError('Release cancelled.', 130)
}

export class InteractiveReleasePrompt implements ReleasePrompt {
  async selectVersion(currentVersion: string): Promise<string> {
    const choices = versionChoices(currentVersion)
    const selection = await select({
      message: `Current version: ${currentVersion}`,
      options: [
        { value: choices.patch, label: 'patch', hint: choices.patch },
        { value: choices.minor, label: 'minor', hint: choices.minor },
        { value: choices.major, label: 'major', hint: choices.major },
        { value: 'custom', label: 'custom' },
      ],
    })
    if (isCancel(selection)) cancelled()
    if (selection !== 'custom') return selection

    const custom = await text({
      message: 'Version',
      placeholder: currentVersion,
      validate(value) {
        if (!value || !valid(value)) return 'Enter a valid semantic version.'
        if (value === currentVersion) return 'The new version must differ from the current version.'
        return undefined
      },
    })
    if (isCancel(custom)) cancelled()
    return custom
  }

  async confirmNpmLogin(): Promise<boolean> {
    const answer = await confirm({
      message: 'npm authentication was not found. Run npm login now?',
      initialValue: true,
    })
    if (isCancel(answer)) cancelled()
    return answer
  }
}
