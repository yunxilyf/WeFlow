import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { promisify } from 'util'
import { execFile, spawnSync } from 'child_process'
import * as https from 'https'
import * as http from 'http'
import { ConfigService } from './config'

const execFileAsync = promisify(execFile)

type WhisperModelInfo = {
  name: string
  fileName: string
  sizeLabel: string
  sizeBytes?: number
}

type DownloadProgress = {
  modelName: string
  downloadedBytes: number
  totalBytes?: number
  percent?: number
}

const WHISPER_MODELS: Record<string, WhisperModelInfo> = {
  tiny: { name: 'tiny', fileName: 'ggml-tiny.bin', sizeLabel: '75 MB', sizeBytes: 75_000_000 },
  base: { name: 'base', fileName: 'ggml-base.bin', sizeLabel: '142 MB', sizeBytes: 142_000_000 },
  small: { name: 'small', fileName: 'ggml-small.bin', sizeLabel: '466 MB', sizeBytes: 466_000_000 },
  medium: { name: 'medium', fileName: 'ggml-medium.bin', sizeLabel: '1.5 GB', sizeBytes: 1_500_000_000 },
  'large-v3': { name: 'large-v3', fileName: 'ggml-large-v3.bin', sizeLabel: '2.9 GB', sizeBytes: 2_900_000_000 }
}

const WHISPER_SOURCES: Record<string, string> = {
  official: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  tsinghua: 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main'
}

function getStaticFfmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static')
    if (typeof ffmpegStatic === 'string' && existsSync(ffmpegStatic)) {
      return ffmpegStatic
    }
    const devPath = join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
    if (existsSync(devPath)) {
      return devPath
    }
    if (app.isPackaged) {
      const resourcesPath = process.resourcesPath
      const packedPath = join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
      if (existsSync(packedPath)) {
        return packedPath
      }
    }
    return null
  } catch {
    return null
  }
}

export class VoiceTranscribeService {
  private configService = new ConfigService()
  private downloadTasks = new Map<string, Promise<{ success: boolean; path?: string; error?: string }>>()

  private resolveModelInfo(modelName: string): WhisperModelInfo | null {
    return WHISPER_MODELS[modelName] || null
  }

  private resolveModelDir(overrideDir?: string): string {
    const configured = overrideDir || this.configService.get('whisperModelDir')
    if (configured) return configured
    return join(app.getPath('userData'), 'models', 'whisper')
  }

  private resolveModelPath(modelName: string, overrideDir?: string): string | null {
    const info = this.resolveModelInfo(modelName)
    if (!info) return null
    return join(this.resolveModelDir(overrideDir), info.fileName)
  }

  private resolveSourceUrl(overrideSource?: string): string {
    const configured = overrideSource || this.configService.get('whisperDownloadSource')
    if (configured && WHISPER_SOURCES[configured]) return WHISPER_SOURCES[configured]
    return WHISPER_SOURCES.official
  }

  async getModelStatus(payload: { modelName: string; downloadDir?: string }): Promise<{
    success: boolean
    exists?: boolean
    path?: string
    sizeBytes?: number
    error?: string
  }> {
    const modelPath = this.resolveModelPath(payload.modelName, payload.downloadDir)
    if (!modelPath) {
      return { success: false, error: '未知模型名称' }
    }
    if (!existsSync(modelPath)) {
      return { success: true, exists: false, path: modelPath }
    }
    const sizeBytes = statSync(modelPath).size
    return { success: true, exists: true, path: modelPath, sizeBytes }
  }

  async downloadModel(
    payload: { modelName: string; downloadDir?: string; source?: string },
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    const info = this.resolveModelInfo(payload.modelName)
    if (!info) {
      return { success: false, error: '未知模型名称' }
    }

    const modelPath = this.resolveModelPath(payload.modelName, payload.downloadDir)
    if (!modelPath) {
      return { success: false, error: '模型路径生成失败' }
    }

    if (existsSync(modelPath)) {
      return { success: true, path: modelPath }
    }

    const cacheKey = `${payload.modelName}:${modelPath}`
    const pending = this.downloadTasks.get(cacheKey)
    if (pending) return pending

    const task = (async () => {
      try {
        const targetDir = this.resolveModelDir(payload.downloadDir)
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true })
        }

        const baseUrl = this.resolveSourceUrl(payload.source)
        const url = `${baseUrl}/${info.fileName}`
        await this.downloadToFile(url, modelPath, payload.modelName, onProgress)
        return { success: true, path: modelPath }
      } catch (error) {
        try { if (existsSync(modelPath)) unlinkSync(modelPath) } catch { }
        return { success: false, error: String(error) }
      } finally {
        this.downloadTasks.delete(cacheKey)
      }
    })()

    this.downloadTasks.set(cacheKey, task)
    return task
  }

  async transcribeWavBuffer(wavData: Buffer): Promise<{ success: boolean; transcript?: string; error?: string }> {
    const modelName = this.configService.get('whisperModelName') || 'base'
    const modelPath = this.resolveModelPath(modelName)
    console.info('[VoiceTranscribe] check model', { modelName, modelPath, exists: modelPath ? existsSync(modelPath) : false })
    if (!modelPath || !existsSync(modelPath)) {
      return { success: false, error: '未下载语音模型，请在设置中下载' }
    }

    // 使用内置的预编译 whisper-cli.exe
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')
    const whisperExe = join(resourcesPath, 'whisper-cli.exe')
    
    if (!existsSync(whisperExe)) {
      return { success: false, error: '找不到语音转写程序，请重新安装应用' }
    }

    const ffmpegPath = getStaticFfmpegPath() || 'ffmpeg'
    console.info('[VoiceTranscribe] ffmpeg path', ffmpegPath)

    const tempDir = app.getPath('temp')
    const fileToken = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    const inputPath = join(tempDir, `weflow_voice_${fileToken}.wav`)
    const outputPath = join(tempDir, `weflow_voice_${fileToken}_16k.wav`)

    try {
      writeFileSync(inputPath, wavData)
      console.info('[VoiceTranscribe] converting to 16kHz', { inputPath, outputPath })
      await execFileAsync(ffmpegPath, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', outputPath])
      
      console.info('[VoiceTranscribe] transcribing with whisper', { whisperExe, modelPath })
      const { stdout, stderr } = await execFileAsync(whisperExe, [
        '-m', modelPath,
        '-f', outputPath,
        '-l', 'zh',
        '-otxt',
        '-np'  // no prints (只输出结果)
      ], {
        maxBuffer: 10 * 1024 * 1024,
        cwd: dirname(whisperExe),  // 设置工作目录为 whisper-cli.exe 所在目录，确保能找到 DLL
        env: { ...process.env, PATH: `${dirname(whisperExe)};${process.env.PATH}` }
      })

      console.info('[VoiceTranscribe] whisper stdout:', stdout)
      if (stderr) console.warn('[VoiceTranscribe] whisper stderr:', stderr)

      // 解析输出文本
      const outputBase = outputPath.replace(/\.[^.]+$/, '')
      const txtFile = `${outputBase}.txt`
      let transcript = ''
      if (existsSync(txtFile)) {
        const { readFileSync } = await import('fs')
        transcript = readFileSync(txtFile, 'utf-8').trim()
        unlinkSync(txtFile)
      } else {
        // 从 stdout 提取（使用 -np 参数后，stdout 只有转写结果）
        transcript = stdout.trim()
      }

      console.info('[VoiceTranscribe] success', { transcript })
      return { success: true, transcript }
    } catch (error: any) {
      console.error('[VoiceTranscribe] failed', error)
      console.error('[VoiceTranscribe] stderr:', error.stderr)
      console.error('[VoiceTranscribe] stdout:', error.stdout)
      return { success: false, error: String(error) }
    } finally {
      try { if (existsSync(inputPath)) unlinkSync(inputPath) } catch { }
      try { if (existsSync(outputPath)) unlinkSync(outputPath) } catch { }
    }
  }

  private downloadToFile(
    url: string,
    targetPath: string,
    modelName: string,
    onProgress?: (progress: DownloadProgress) => void,
    remainingRedirects = 3
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      const request = protocol.get(url, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
          if (remainingRedirects <= 0) {
            reject(new Error('下载重定向次数过多'))
            return
          }
          this.downloadToFile(response.headers.location, targetPath, modelName, onProgress, remainingRedirects - 1)
            .then(resolve)
            .catch(reject)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`下载失败: ${response.statusCode}`))
          return
        }

        const totalBytes = Number(response.headers['content-length'] || 0) || undefined
        let downloadedBytes = 0

        const writer = createWriteStream(targetPath)

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length
          const percent = totalBytes ? (downloadedBytes / totalBytes) * 100 : undefined
          onProgress?.({ modelName, downloadedBytes, totalBytes, percent })
        })

        response.on('error', (error) => {
          try { writer.close() } catch { }
          reject(error)
        })

        writer.on('error', (error) => {
          try { writer.close() } catch { }
          reject(error)
        })

        writer.on('finish', () => {
          writer.close()
          resolve()
        })

        response.pipe(writer)
      })

      request.on('error', reject)
    })
  }
}

export const voiceTranscribeService = new VoiceTranscribeService()
