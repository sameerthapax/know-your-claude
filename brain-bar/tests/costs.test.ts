import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const QUIZ = {
  questions: ['easy', 'easy', 'medium', 'medium', 'hard'].map((difficulty, n) => ({
    difficulty,
    question: 'Question ' + (n + 1) + '?',
    choices: ['first', 'second', 'third', 'fourth'],
    answer: 1,
    why: 'Because the second one is right.',
  })),
}
const BAND = {
  plugin: 'brain-bar',
  surface: 'terminal' as const,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}
const PANE = {
  plugin: 'brain-bar',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'brain-test',
  props: { title: 'Brain test', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

function world(on: any, hp: number, existing: Record<string, string> = {}) {
  mock.store(on, { 'hp:/repo': hp })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('audio.play', () => ({ value: undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: e.path in existing }))
  on('fs.read', ($: any, e: any) => ({ value: existing[e.path] ?? '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify(QUIZ), usage: USAGE } }))
}

const shownHp = async ($: any) => {
  const band = await $.ui.mount(BAND)
  return (await band.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')
}

test('a new architecture file costs double for its lines, plus 50 for being new', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000)
  await $.session.start({ cwd: '/repo' })
  // 2 added lines: 2 x 4 = 8, doubled = 16, plus 50 for a new file = 66
  await $.tool.call({ tool: 'Write', file_path: '/repo/infra/main.tf', content: 'a\nb\n' })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('8,934 / 10,000 HP')
})

test('editing an ordinary existing file costs only its lines', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 9000, { '/repo/src/app.ts': 'a\n' })
  await $.session.start({ cwd: '/repo' })
  // 1 changed line: 2
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('8,998 / 10,000 HP')
})

test('a wrong answer costs 100 HP', async ($, on) => {
  const clock = mock.clock(on)
  world(on, 5000)
  await $.session.start({ cwd: '/repo' })
  await $.command.run({ command: 'brain-test', args: '' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'ans-0' })
  await clock.advance(2000)
  expect(await shownHp($)).toContain('4,900 / 10,000 HP')
  const pane = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' ')
  expect(pane).toContain('WRONG  −100 HP')
})
