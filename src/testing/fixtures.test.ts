/**
 * Direct coverage for createTagFixture() (§6b): both the default isolated
 * mode (transport only installed transiently) and installGlobally:true
 * (which calls setNfcTransport() permanently), plus the tag-array/no-tag
 * argument shapes.
 */
import {getNfcTransport, resetNfcTransport, setNfcTransport} from '../NfcModule';
import {createTagFixture} from './fixtures';
import {InMemoryNfcTransport} from './in-memory-transport';
import {EmptyTag, TextTag} from './simulated-tag';

describe('createTagFixture()', () => {
  afterEach(() => {
    resetNfcTransport();
  });

  test('with no tag: tagHandle is undefined and tagHandles is empty', () => {
    const {tagHandle, tagHandles} = createTagFixture();
    expect(tagHandle).toBeUndefined();
    expect(tagHandles).toEqual([]);
  });

  test('with a single tag: tagHandle is that tag\'s handle, tagHandles has one entry', () => {
    const tag = new EmptyTag();
    const {tagHandle, tagHandles, transport} = createTagFixture(tag);
    expect(tagHandle).toBeDefined();
    expect(tagHandle?.tag).toBe(tag);
    expect(tagHandles).toHaveLength(1);
    expect(transport).toBeInstanceOf(InMemoryNfcTransport);
  });

  test('with multiple tags: tagHandle is the first, tagHandles covers all in order', () => {
    const tagA = new EmptyTag();
    const tagB = new TextTag({text: 'hi'});
    const {tagHandle, tagHandles} = createTagFixture([tagA, tagB]);
    expect(tagHandle?.tag).toBe(tagA);
    expect(tagHandles.map(h => h.tag)).toEqual([tagA, tagB]);
  });

  test('without installGlobally: the reader works, but getNfcTransport() is left untouched', () => {
    const previous = getNfcTransport();
    const {reader, transport} = createTagFixture(new EmptyTag());
    // The global override is unaffected by an isolated fixture.
    expect(getNfcTransport()).toBe(previous);
    expect(transport).not.toBe(previous);
    return expect(reader.scan()).resolves.toBeUndefined();
  });

  test('without installGlobally: a pre-existing global override survives fixture creation unchanged', () => {
    const preExisting = new InMemoryNfcTransport();
    setNfcTransport(preExisting);
    createTagFixture(new EmptyTag());
    expect(getNfcTransport()).toBe(preExisting);
  });

  test('with installGlobally:true: setNfcTransport() is called, installing this fixture\'s transport globally', () => {
    const {reader, transport} = createTagFixture(new EmptyTag(), {
      installGlobally: true,
    });
    expect(getNfcTransport()).toBe(transport);
    return expect(reader.scan()).resolves.toBeUndefined();
  });
});
