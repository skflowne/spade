import { expect, test } from '@playwright/test'
import {
  IMAGE_EXTENSIONS,
  isAbsolutePath,
  isImagePath,
  isNetworkPath,
  isPathInside,
  needsNetworkApproval,
  isSamePath,
  pathBaseName,
  pathKey,
  resolveProjectPath,
  splitLineSuffix
} from '../../src/shared/paths'

test('comparison keys ignore case, separator style, repeated and trailing separators, and dot segments', () => {
  expect(pathKey('C:\\Work\\Framework')).toBe('c:\\work\\framework')
  expect(pathKey('c:/work/framework/')).toBe('c:\\work\\framework')
  expect(pathKey('C:\\work\\\\framework\\\\')).toBe('c:\\work\\framework')
  expect(pathKey('C:\\work\\.\\tmp\\..\\framework')).toBe('c:\\work\\framework')
  expect(pathKey('C:\\')).toBe('c:\\')
  expect(pathKey('C:/')).toBe('c:\\')
  expect(pathKey('C:\\..')).toBe('c:\\')
})

test('comparison keys handle UNC shares and long-path prefixes', () => {
  expect(pathKey('\\\\Server\\Share\\Dir\\')).toBe('\\\\server\\share\\dir')
  expect(pathKey('//server/share/dir')).toBe('\\\\server\\share\\dir')
  expect(pathKey('\\\\server\\share')).toBe('\\\\server\\share')
  expect(pathKey('\\\\server\\share\\..\\..')).toBe('\\\\server\\share')
  expect(pathKey('\\\\?\\C:\\Work\\Framework')).toBe('c:\\work\\framework')
  expect(pathKey('\\\\?\\UNC\\Server\\Share\\Dir')).toBe('\\\\server\\share\\dir')
  expect(pathKey('\\\\.\\C:\\Work')).toBe('c:\\work')
})

test('comparison keys handle POSIX paths used on development machines', () => {
  expect(pathKey('/home/Dev/project/')).toBe('\\home\\dev\\project')
  expect(pathKey('/')).toBe('\\')
})

test('same-path checks compare every spelling of one location', () => {
  expect(isSamePath('C:\\Work\\Framework', 'c:/work/framework/')).toBe(true)
  expect(isSamePath('\\\\?\\C:\\Work\\Framework', 'C:\\work\\framework')).toBe(true)
  expect(isSamePath('\\\\?\\UNC\\srv\\share\\a', '//SRV/share/a/')).toBe(true)
  expect(isSamePath('C:\\Work\\Framework', 'D:\\Work\\Framework')).toBe(false)
  expect(isSamePath('C:\\Work\\Frame', 'C:\\Work\\Framework')).toBe(false)
})

test('inside checks require a whole-segment prefix and exclude the directory itself', () => {
  expect(isPathInside('C:\\Work\\Framework\\src\\a.ts', 'c:/work/framework')).toBe(true)
  expect(isPathInside('C:\\Work\\Framework', 'C:\\Work\\Framework\\')).toBe(false)
  expect(isPathInside('C:\\Work\\FrameworkX\\a.ts', 'C:\\Work\\Framework')).toBe(false)
  expect(isPathInside('C:\\Work\\Framework\\..\\other', 'C:\\Work\\Framework')).toBe(false)
  expect(isPathInside('C:\\a', 'C:\\')).toBe(true)
  expect(isPathInside('\\\\?\\UNC\\srv\\share\\x\\y', '\\\\srv\\share')).toBe(true)
  expect(isPathInside('\\\\srv\\sharex\\y', '\\\\srv\\share')).toBe(false)
  expect(isPathInside('/home/dev/project/a', '/home/dev/project')).toBe(true)
})

test('detects absolute drive, UNC, long-path, and POSIX paths', () => {
  for (const path of ['C:\\x', 'c:/x', 'C:\\', 'C:', '\\\\server\\share', '//server/share', '\\\\?\\C:\\x', '\\\\?\\UNC\\s\\h', '/home/x', '\\x']) {
    expect(isAbsolutePath(path), path).toBe(true)
  }
  for (const path of ['src\\a.ts', 'src/a.ts', './a.ts', '..\\a', 'a.png', '']) {
    expect(isAbsolutePath(path), path).toBe(false)
  }
})

test('resolves relative paths against the project root in the root separator style', () => {
  expect(resolveProjectPath('C:\\Work\\Framework', 'src\\a.ts')).toBe('C:\\Work\\Framework\\src\\a.ts')
  expect(resolveProjectPath('C:\\Work\\Framework\\', './src/a.ts')).toBe('C:\\Work\\Framework\\src\\a.ts')
  expect(resolveProjectPath('C:\\Work\\Framework', '..\\Other\\b.png')).toBe('C:\\Work\\Other\\b.png')
  expect(resolveProjectPath('C:\\Work', '..\\..\\..\\x')).toBe('C:\\x')
  expect(resolveProjectPath('\\\\srv\\share\\proj', 'a/b')).toBe('\\\\srv\\share\\proj\\a\\b')
  expect(resolveProjectPath('\\\\?\\C:\\Work', 'a\\..\\b')).toBe('\\\\?\\C:\\Work\\b')
  expect(resolveProjectPath('\\\\?\\UNC\\srv\\share', 'a')).toBe('\\\\?\\UNC\\srv\\share\\a')
  expect(resolveProjectPath('\\\\.\\C:\\Work', 'a/b')).toBe('\\\\.\\C:\\Work\\a\\b')
  expect(resolveProjectPath('/home/dev/project', 'src/../docs/a.md')).toBe('/home/dev/project/docs/a.md')
  expect(resolveProjectPath('C:\\Work', '.')).toBe('C:\\Work')
})

test('normalizes absolute paths in their own style instead of joining them to the root', () => {
  expect(resolveProjectPath('C:\\Work', 'D:\\Other\\.\\x.png')).toBe('D:\\Other\\x.png')
  expect(resolveProjectPath('C:\\Work', 'D:/Other/x.png')).toBe('D:/Other/x.png')
  expect(resolveProjectPath('/home/dev', '/tmp//x/')).toBe('/tmp/x')
  expect(resolveProjectPath('C:\\Work', '\\\\srv\\share\\x\\')).toBe('\\\\srv\\share\\x')
})

test('splits :line and :line:column suffixes without breaking drive letters', () => {
  expect(splitLineSuffix('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12, column: null })
  expect(splitLineSuffix('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', line: 12, column: 5 })
  expect(splitLineSuffix('C:\\Work\\a.ts:40')).toEqual({ path: 'C:\\Work\\a.ts', line: 40, column: null })
  expect(splitLineSuffix('C:\\Work\\a.ts')).toEqual({ path: 'C:\\Work\\a.ts', line: null, column: null })
  expect(splitLineSuffix('C:\\')).toEqual({ path: 'C:\\', line: null, column: null })
  expect(splitLineSuffix('C:12')).toEqual({ path: 'C:12', line: null, column: null })
  expect(splitLineSuffix('a.ts:0')).toEqual({ path: 'a.ts:0', line: null, column: null })
  expect(splitLineSuffix('a.ts:x')).toEqual({ path: 'a.ts:x', line: null, column: null })
  expect(splitLineSuffix('\\\\?\\C:\\a.ts:7:1')).toEqual({ path: '\\\\?\\C:\\a.ts', line: 7, column: 1 })
})

test('base names come from the last segment of any path form', () => {
  expect(pathBaseName('C:\\Work\\Framework\\')).toBe('Framework')
  expect(pathBaseName('src/a.ts')).toBe('a.ts')
  expect(pathBaseName('\\\\srv\\share')).toBe('share')
  expect(pathBaseName('\\\\?\\UNC\\srv\\share\\dir')).toBe('dir')
  expect(pathBaseName('C:\\')).toBe('C:')
  expect(pathBaseName('/home/dev')).toBe('dev')
})

test('recognizes image paths by extension, case-insensitively', () => {
  expect([...IMAGE_EXTENSIONS].sort()).toEqual(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
  for (const path of ['a.png', 'C:\\x\\Shot.PNG', 'b.jpg', 'c.JPEG', 'd.gif', 'e.webp', '/x/f.svg']) {
    expect(isImagePath(path), path).toBe(true)
  }
  for (const path of ['a.ts', 'png', 'C:\\images.png\\notes.txt', 'a.png.txt', '.png', 'C:\\x\\']) {
    expect(isImagePath(path), path).toBe(false)
  }
})

test('network paths are UNC shares in every spelling, and device paths that are not a drive letter', () => {
  for (const path of [
    '\\\\server\\share\\x.png',
    '\\\\server\\share',
    '//server/share/x',
    '\\/server/share',
    '\\\\?\\UNC\\server\\share\\x',
    '\\\\?\\unc\\server\\share',
    '\\\\.\\UNC\\server\\share\\x',
    // Device namespaces can reach other machines too (GLOBALROOT\Device\Mup).
    '\\\\?\\GLOBALROOT\\Device\\Mup\\server\\share\\x',
    '\\\\.\\pipe\\name'
  ]) {
    expect(isNetworkPath(path), path).toBe(true)
  }
  for (const path of ['C:\\x\\y.png', 'c:/x', '\\\\?\\C:\\x', '\\\\.\\C:\\x', '\\x', 'relative\\x', '/home/dev/x', '']) {
    expect(isNetworkPath(path), path).toBe(false)
  }
})

test('a network path needs approval unless it is the project root or inside it', () => {
  expect(needsNetworkApproval('\\\\evil\\share\\x.png', 'C:\\Work\\Framework')).toBe(true)
  expect(needsNetworkApproval('\\\\?\\UNC\\evil\\share\\x', 'C:\\Work\\Framework')).toBe(true)
  expect(needsNetworkApproval('C:\\Work\\Other\\x.png', 'C:\\Work\\Framework')).toBe(false)

  const root = '\\\\fileserver\\team\\framework'
  expect(needsNetworkApproval('\\\\FileServer\\Team\\Framework\\src\\a.ts', root)).toBe(false)
  expect(needsNetworkApproval('//fileserver/team/framework/', root)).toBe(false)
  expect(needsNetworkApproval('\\\\?\\UNC\\fileserver\\team\\framework\\b.png', root)).toBe(false)
  expect(needsNetworkApproval('\\\\fileserver\\team\\framework\\..\\secrets\\x', root)).toBe(true)
  expect(needsNetworkApproval('\\\\fileserver\\team\\frameworkx\\a', root)).toBe(true)
  expect(needsNetworkApproval('\\\\fileserver\\other\\a', root)).toBe(true)
})
