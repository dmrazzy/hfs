// This file is part of HFS - Copyright 2021-2022, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import { Readable } from 'stream'
// @ts-ignore
import { crc32 as crc32lib } from 'buffer-crc32'
import assert from 'assert'

const ZIP64_LIMIT = 2**31 -1

let crc32function: (input: string | Buffer, initialState?: number | undefined | null) => number
import('@node-rs/crc32').then(lib => crc32function = lib.crc32, () => {
    console.log('using generic lib for crc32')
    return crc32function = crc32lib.unsigned
})

interface ZipSource {
    path: string
    sourcePath?: string
    getData: () => Readable // deferred stream, so that we don't keep many open files because of calculateSize()
    size: number
    ts: Date
    mode?: number
}
export class QuickZipStream extends Readable {
    private workingFile = false
    private numberOfFiles: number = 0
    private finished = false
    private readonly centralDir: ({ size:number, crc:number, ts:Date, pathAsBuffer:Buffer, offset:number, version:number, extAttr: number })[] = []
    private dataWritten = 0
    private consumedCalculating: ZipSource[] = []
    private skip: number = 0
    private limit?: number

    constructor(private readonly walker:  AsyncIterableIterator<ZipSource>) {
        super({})
    }

    earlyClose() {
        this.finished = true
        this.push(null)
    }

    applyRange(start: number, end: number) {
        if (end < start)
            return this.earlyClose()
        this.skip = start
        this.limit = end - start + 1
    }

    _push(chunk: number[] | Buffer) {
        if (Array.isArray(chunk))
            chunk = buffer(chunk)
        this.dataWritten += chunk.length
        if (this.skip) {
            if (this.skip >= chunk.length)
                return this.skip -= chunk.length
            chunk = chunk.subarray(this.skip)
            this.skip = 0
        }
        const lastBit = this.limit! < chunk.length
        if (lastBit)
            chunk = chunk.subarray(0, this.limit)

        this.push(chunk)
        if (lastBit)
            this.earlyClose()
    }

    async calculateSize(howLong:number = 1000) {
        const endBy = Date.now() + howLong
        while (1) {
            if (Date.now() >= endBy)
                return NaN
            const { value } = await this.walker.next()
            if (!value) break
            this.consumedCalculating.push(value) // we keep same shape of the generator, so
        }
        let offset = 0
        let centralDirSize = 0
        for (const file of this.consumedCalculating) {
            const pathSize = Buffer.from(file.path, 'utf8').length
            const extraLength = (file.size > ZIP64_LIMIT ? 2 : 0) + (offset > ZIP64_LIMIT ? 1 : 0)
            const extraDataSize = extraLength && (2+2 + extraLength*8)
            offset += 4+2+2+2+ 4+4+4+4+ 2+2+ pathSize + file.size
            centralDirSize += 4+2+2+2+2+ 4+4+4+4+ 2+2+2+2+2+ 4+4 + pathSize + extraDataSize
        }
        const centralOffset = offset
        if (centralOffset > ZIP64_LIMIT)
            centralDirSize += 4+8+2+2+4+4+8+8+8+8+4+4+8+4
        centralDirSize += 4+4+2+2+4+4+2
        return offset + centralDirSize
    }

    async _read() {
        if (this.workingFile || this.finished || this.destroyed) return
        const file = this.consumedCalculating.shift() || (await this.walker.next()).value as ZipSource
        if (!file)
            return this.closeArchive()
        ++this.numberOfFiles
        let { path, sourcePath, getData, size, ts, mode } = file
        const pathAsBuffer = Buffer.from(path, 'utf8')
        const offset = this.dataWritten
        let version = 20
        this._push([
            4, 0x04034b50,
            2, version,
            2, 0x08, // flags
            2, 0, // compression = store
            ...ts2buf(ts),
            4, 0, // crc
            4, 0, // size
            4, 0, // size
            2, pathAsBuffer.length,
            2, 0, // extra length
        ])
        this._push(pathAsBuffer)
        if (this.finished) return

        const cache = sourcePath ? crcCache[sourcePath] : undefined
        const cacheHit = Number(cache?.ts) === Number(ts)
        let crc = cacheHit ? cache!.crc : crc32function('')
        const extAttr = !mode ? 0 : (mode | 0x8000) * 0x10000 // it's like <<16 but doesn't overflow so easily
        const centralDirEntry = { size, crc, pathAsBuffer, ts, offset, version, extAttr }
        if (this.skip >= size && cacheHit) {
            this.skip -= size
            this.dataWritten += size
            this.centralDir.push(centralDirEntry)
            setTimeout(() => this.push('')) // this "signal" works only after _read() is done
            return
        }
        const data = getData()
        data.on('error', (err) => console.error(err))
        data.on('end', ()=>{
            this.workingFile = false
            centralDirEntry.crc = crc
            if (sourcePath)
                crcCache[sourcePath] = { ts, crc }
            this.centralDir.push(centralDirEntry)
            this.push('') // continue piping
        })
        this.workingFile = true
        data.on('data', chunk => {
            if (this.destroyed)
                return data.destroy()
            this._push(chunk)
            if (!cacheHit)
                crc = crc32function(chunk, crc)
            if (this.finished)
                return data.destroy()
        })
    }

    closeArchive() {
        this.finished = true
        let centralOffset = this.dataWritten
        for (let { size, ts, crc, offset, pathAsBuffer, version, extAttr } of this.centralDir) {
            const extra = []
            if (size > ZIP64_LIMIT) {
                extra.push(size, size)
                size = 0xffffffff
            }
            if (offset > ZIP64_LIMIT) {
                extra.push(offset)
                offset = 0xffffffff
            }
            const extraData = buffer(!extra.length ? []
                : [ 2,1, 2,8*extra.length, ...extra.map(x=> [8,x]).flat() ])
            if (extraData.length && version < 45)
                version = 45
            this._push([
                4, 0x02014b50, // central dir signature
                2, version,
                2, version,
                2, 0x08, // flags (bit3 = no crc in local header)
                2, 0,    // compression method = store
                ...ts2buf(ts),
                4, crc,
                4, size, // compressed
                4, size,
                2, pathAsBuffer.length,
                2, extraData.length,
                2, 0, //comment length
                2, 0, // disk
                2, 0, // attr
                4, extAttr,
                4, offset,
            ])
            this._push(pathAsBuffer)
            this._push(extraData)
        }
        const n = this.centralDir.length
        const after = this.dataWritten
        let centralSize = after-centralOffset
        if (centralOffset > ZIP64_LIMIT) {
            this._push([
                4, 0x06064b50, // end of central dir zip64
                8, 44,
                2, 45,
                2, 45,
                4, 0,
                4, 0,
                8, n,
                8, n,
                8, centralSize,
                8, centralOffset,
            ])
            this._push([
                4, 0x07064b50,
                4, 0,
                8, after,
                4, 1,
            ])
            centralOffset = 0xFFFFFFFF
        }
        this._push([
            4,0x06054b50, // end of central directory signature
            4,0, // disk-related stuff
            2,this.numberOfFiles,
            2,this.numberOfFiles,
            4,centralSize,
            4,centralOffset,
            2,0, // comment length
        ])
        this.push(null) // EOF
    }
}

function buffer(pairs: number[]) {
    assert(pairs.length % 2 === 0)
    let total = 0
    for (let i=0; i < pairs.length; i+=2)
        total += pairs[i]
    const ret = Buffer.alloc(total, 0)
    let offset = 0
    let i = 0
    while (i < pairs.length) {
        const size = pairs[i++]
        const data = pairs[i++]
        if (size === 1)
            ret.writeUInt8(data, offset)
        else if (size === 2)
            ret.writeUInt16LE(data, offset)
        else if (size === 4)
            ret.writeUInt32LE(data, offset)
        else if (size === 8)
            ret.writeBigUInt64LE(BigInt(data), offset)
        else
            throw 'unsupported'
        offset += size
    }
    return ret
}

function ts2buf(ts:Date) {
    const date = ((ts.getFullYear() - 1980) & 0x7F) << 9 | (ts.getMonth() + 1) << 5 | ts.getDate()
    const time = ts.getHours() << 11 | ts.getMinutes() << 5 | (ts.getSeconds() / 2) & 0x0F
    return [
        2, time,
        2, date,
    ]
}

interface CrcCacheEntry { ts: Date, crc: number }
const crcCache: Record<string, CrcCacheEntry> = {}
