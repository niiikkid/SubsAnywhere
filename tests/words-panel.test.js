import test from 'node:test';
import assert from 'node:assert/strict';
import {
  studyDeck, nextStudyPosition, previousStudyPosition, studyPositionForWord, learningText, wordsTsv
} from '../local-server/web/words.js';

const words = [
  { id: 1, text: '你好', learned: false },
  { id: 2, text: 'hello', learned: true },
  { id: 3, text: '谢谢', learned: false },
];

test('study deck contains every word marked for review in its saved order', () => {
  assert.deepEqual(studyDeck(words).map((word) => word.id), [1, 3]);
});

test('study progress reaches completion only after the final card and stays there', () => {
  assert.equal(nextStudyPosition(0, 2), 1);
  assert.equal(nextStudyPosition(1, 2), 2);
  assert.equal(nextStudyPosition(2, 2), 2);
  assert.equal(nextStudyPosition(0, 0), 0);
});

test('study can return to the previous card without moving before the first word', () => {
  assert.equal(previousStudyPosition(2, 3), 1);
  assert.equal(previousStudyPosition(0, 3), 0);
  assert.equal(previousStudyPosition(3, 3), 2);
});

test('saved study word restores its exact unlearned card after a page reload', () => {
  assert.equal(studyPositionForWord(words, 3), 1);
  assert.equal(studyPositionForWord(words, 2), -1);
  assert.equal(studyPositionForWord(words, 999), -1);
});

test('Chinese saved sentences are learned through pinyin instead of Han characters', () => {
  const sentence = { language: 'zh', text: '我已经吃过饭了。', pinyin: 'wǒ yǐjīng chī guò fàn le.' };
  assert.equal(learningText(sentence, 'sentences'), sentence.pinyin);
  assert.equal(learningText(sentence, 'words'), sentence.text);
  assert.equal(learningText({ language: 'en', text: 'I have already eaten.', pinyin: '' }, 'sentences'), 'I have already eaten.');
});

test('word export is compact TSV with source, Chinese pronunciation, and Russian translation only', () => {
  assert.equal(wordsTsv([
    { language: 'zh', text: '你好', pinyin: 'nǐ hǎo', translation: 'привет' },
    { language: 'en', text: 'take off', pinyin: '', translation: 'снимать; взлетать' },
  ]), 'word\tpinyin\ttranslation\n你好\tnǐ hǎo\tпривет\ntake off\t\tснимать; взлетать\n');
});

test('word export prevents spreadsheet formulas in saved subtitle and translation text', () => {
  assert.equal(wordsTsv([
    { language: 'en', text: '=HYPERLINK("https://example.test")', pinyin: '', translation: '+unsafe' },
  ]), 'word\tpinyin\ttranslation\n\'=HYPERLINK("https://example.test")\t\t\'+unsafe\n');
});
