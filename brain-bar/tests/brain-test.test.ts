import { expect, mock, test } from 'claude-code/testing'

const QUIZ = {
  questions: ['easy', 'easy', 'medium', 'medium', 'hard'].map((difficulty, n) => ({
    difficulty,
    question: 'Question ' + (n + 1) + '?',
    choices: ['first', 'second', 'third', 'fourth'],
    answer: 1,
    why: 'Because the second one is right.',
  })),
}

const PANE_PROPS = {
  title: 'Brain test',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('the brain test runs in its pane: cards, a right answer, and the HP it wins', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { 'hp:/repo': 9000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('fs.exists', () => ({ value: false }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: JSON.stringify(QUIZ), usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))

  await $.session.start({ cwd: '/repo' })
  await $.command.run({ command: 'brain-test', args: 'animation' })

  const ui = await $.ui.mount({ plugin: 'brain-bar', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'brain-test' })
  expect((await ui.findAll({ type: 'Button' })).length).toBe(4)
  expect((await ui.find({ key: 'ans-1' }))?.text).toContain('[B]')
  const shown = (await ui.findAll({ type: 'Text' })).map((t) => t.text).join(' ')
  expect(shown).toContain('second')

  // Pick B, the right answer: +200 HP
  await ui.press({ key: 'ans-1' })
  await clock.advance(2000)
  const band = await $.ui.mount({
    plugin: 'brain-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const texts = (await band.findAll({ type: 'Text' })).map((t) => t.text).join(' ')
  expect(texts).toContain('9,200 / 10,000 HP')
})
