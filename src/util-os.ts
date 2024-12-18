import { dirname, resolve } from 'path'
import { existsSync } from 'fs'
import { exec, ExecOptions, execSync, spawnSync } from 'child_process'
import { exists, onlyTruthy, prefix, splitAt } from './misc'
import _ from 'lodash'
import { pid } from 'node:process'
import { promisify } from 'util'
import { IS_WINDOWS } from './const'

const DF_TIMEOUT = 2000
const LOGICALDISK_TIMEOUT = DF_TIMEOUT

// not using statfsSync because it's not available in node 18.5.0 (latest version with pkg)
export function getDiskSpaceSync(path: string) {
    if (IS_WINDOWS)
        return parseLogicaldisk(execSync(makeLogicaldisk(path), { timeout: LOGICALDISK_TIMEOUT }).toString())[0]
    while (path && !existsSync(path))
        path = dirname(path)
    try { return parseDfResult(spawnSync('df', ['-k', path], { timeout: DF_TIMEOUT }).stdout.toString())[0] }
    catch(e: any) { throw parseDfResult(e) }
}

export function bashEscape(par: string) {
    return `'${par.replaceAll(/(["'$`\\])/g, "\\$1")}'`
}

export function cmdEscape(par: string) {
    return `"${par.replaceAll('"', '\\"')}"`
}

export async function getDiskSpace(path: string) {
    if (IS_WINDOWS)
        return parseLogicaldisk(await runCmd(makeLogicaldisk(path), [], { timeout: LOGICALDISK_TIMEOUT }))[0]
    while (path && !await exists(path))
        path = dirname(path)
    return parseDfResult(await promisify(exec)(`df -k`, { timeout: DF_TIMEOUT }).then(x => x.stdout, e => e))[0]
}

export async function getDiskSpaces(): Promise<{ name: string, free: number, total: number, description?: string }[]> {
    if (IS_WINDOWS) {
        const drives = await getDrives() // since network-drives can hang 'wmic' for many seconds checking disk space (issue#648), and a single timeout would make whole operation fail, so we fork the job on each drive
        return onlyTruthy(await Promise.all(drives.map(getDiskSpace)))
    }
    return parseDfResult(await promisify(exec)(`df -k`, { timeout: DF_TIMEOUT }).then(x => x.stdout, e => e))
}

function parseDfResult(result: string | Error) {
    if (result instanceof Error) {
        const { status } = result as any
        throw status === 1 ? Error('miss') : status === 127 ? Error('unsupported') : result
    }
    const out = result.split('\n')
    if (!out.shift()?.startsWith('Filesystem'))
        throw Error('unsupported')
    return onlyTruthy(out.map(one => {
        const bits = one.split(/\s+/)
        if (bits[0] === 'tempfs') return
        const name = bits.pop() || ''
        if (/^\/(dev|sys|run|System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware))\b/.test(name)) return
        const [used=0, free=0] = bits.map(x => Number(x) * 1024).slice(2)
        const total = used + free
        return total && { free, total, name }
    }))
}

export async function getDrives() {
    const stdout = await runCmd('wmic logicaldisk get name')
    return stdout.split('\n').slice(1).map(x => x.trim()).filter(Boolean)
}

// execute win32 shell commands
export async function runCmd(cmd: string, args: string[] = [], options: ExecOptions = {}) {
    const line = `@chcp 65001 >nul & cmd /c ${cmd} ${args.map(x => x.includes(' ') ? `"${x}"` : x).join(' ')}`
    const { stdout, stderr } = await promisify(exec)(line, { encoding: 'utf-8', ...options })
    return (stderr || stdout).replace(/\r/g, '')
}

async function getWindowsServicePids() {
    const res = await runCmd(`wmic service get ProcessId`)
    return _.uniq(res.split('\n').slice(1).map(x => Number(x.trim())))
}

export const RUNNING_AS_SERVICE = IS_WINDOWS && getWindowsServicePids().then(x => {
    const ret = x.includes(pid)
    if (ret) console.log("running as service")
    return ret
}, e => {
    console.log("couldn't determine if we are running as a service")
    console.debug(e)
})

function parseKeyValueObjects<T extends string>(all: string, keySep='=', lineSep='\n', objectSep=/\n\n+/) {
    return all.split(objectSep).map(obj =>
        Object.fromEntries(obj.split(lineSep).map(kv => splitAt(keySep, kv))) ) as { [k in T]: string }[]
}

const wmicFields = ['Size','FreeSpace','Name','Description'] as const

function makeLogicaldisk(path='') {
    const drive = resolve(path).slice(0, 2).toUpperCase()
    if (!drive.match(/^(|\w:)$/)) throw 'invalid-path'
    return `wmic logicaldisk ${prefix(`where "DeviceID = '`, drive, `'"`)} get ${wmicFields.join()} /format:list`
}

function parseLogicaldisk(out: string) {
    const objs = parseKeyValueObjects<typeof wmicFields[number]>(out.replace(/\r/g, ''))
    return onlyTruthy(objs.map(x => x.Size && {
        total: Number(x.Size),
        free: Number(x.FreeSpace),
        name: x.Name,
        description: x.Description
    }))
}
