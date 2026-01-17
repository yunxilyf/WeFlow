import { app } from 'electron'
import { existsSync, mkdirSync, statSync, unlinkSync, createWriteStream } from 'fs'
import { join } from 'path'
import * as https from 'https'
import * as http from 'http'
import { ConfigService } from './config'

// Sherpa-onnx 类型定义
type OfflineRecognizer = any
type OfflineStream = any

type ModelInfo = {
  name: string
  files: {
    model: string
    tokens: string
    vad: string
  }
  sizeBytes: number
  sizeLabel: string
}

type DownloadProgress = {
  modelName: string
  downloadedBytes: number
  totalBytes?: number
  percent?: number
}

const SENSEVOICE_MODEL: ModelInfo = {
  name: 'SenseVoiceSmall',
  files: {
    model: 'model.int8.onnx',
    tokens: 'tokens.txt',
    vad: 'silero_vad.onnx'
  },
  sizeBytes: 245_000_000,
  sizeLabel: '245 MB'
}

const MODEL_DOWNLOAD_URLS = {
  model: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/model.int8.onnx',
  tokens: 'https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/tokens.txt',
  vad: 'https://www.modelscope.cn/models/manyeyes/silero-vad-onnx/resolve/master/silero_vad.onnx'
}

export class VoiceTranscribeService {
  private configService = new ConfigService()
  private downloadTasks = new Map<string, Promise<{ success: boolean; path?: string; error?: string }>>()
  private recognizer: OfflineRecognizer | null = null
  private isInitializing = false

  private resolveModelDir(): string {
    const configured = this.configService.get('whisperModelDir') as string | undefined
    if (configured) return configured
    return join(app.getPath('documents'), 'WeFlow', 'models', 'sensevoice')
  }

  private resolveModelPath(fileName: string): string {
    return join(this.resolveModelDir(), fileName)
  }

  /**
   * 检查模型状态
   */
  async getModelStatus(): Promise<{
    success: boolean
    exists?: boolean
    modelPath?: string
    tokensPath?: string
    sizeBytes?: number
    error?: string
  }> {
    try {
      const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
      const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)
      const vadPath = this.resolveModelPath((SENSEVOICE_MODEL.files as any).vad)

      const modelExists = existsSync(modelPath)
      const tokensExists = existsSync(tokensPath)
      const vadExists = existsSync(vadPath)
      const exists = modelExists && tokensExists && vadExists

      if (!exists) {
        return { success: true, exists: false, modelPath, tokensPath }
      }

      const modelSize = statSync(modelPath).size
      const tokensSize = statSync(tokensPath).size
      const vadSize = statSync(vadPath).size
      const totalSize = modelSize + tokensSize + vadSize

      return {
        success: true,
        exists: true,
        modelPath,
        tokensPath,
        sizeBytes: totalSize
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /**
   * 下载模型文件
   */
  async downloadModel(
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ success: boolean; modelPath?: string; tokensPath?: string; error?: string }> {
    const cacheKey = 'sensevoice'
    const pending = this.downloadTasks.get(cacheKey)
    if (pending) return pending

    const task = (async () => {
      try {
        const modelDir = this.resolveModelDir()
        if (!existsSync(modelDir)) {
          mkdirSync(modelDir, { recursive: true })
        }

        const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
        const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)
        const vadPath = this.resolveModelPath((SENSEVOICE_MODEL.files as any).vad)

        // 初始进度
        onProgress?.({
          modelName: SENSEVOICE_MODEL.name,
          downloadedBytes: 0,
          totalBytes: SENSEVOICE_MODEL.sizeBytes,
          percent: 0
        })

        // 下载模型文件 (40%)
        console.info('[VoiceTranscribe] 开始下载模型文件...')
        await this.downloadToFile(
          MODEL_DOWNLOAD_URLS.model,
          modelPath,
          'model',
          (downloaded, total) => {
            const percent = total ? (downloaded / total) * 40 : undefined
            onProgress?.({
              modelName: SENSEVOICE_MODEL.name,
              downloadedBytes: downloaded,
              totalBytes: SENSEVOICE_MODEL.sizeBytes,
              percent
            })
          }
        )

        // 下载 tokens 文件 (30%)
        console.info('[VoiceTranscribe] 开始下载 tokens 文件...')
        await this.downloadToFile(
          MODEL_DOWNLOAD_URLS.tokens,
          tokensPath,
          'tokens',
          (downloaded, total) => {
            const modelSize = existsSync(modelPath) ? statSync(modelPath).size : 0
            const percent = total ? 40 + (downloaded / total) * 30 : 40
            onProgress?.({
              modelName: SENSEVOICE_MODEL.name,
              downloadedBytes: modelSize + downloaded,
              totalBytes: SENSEVOICE_MODEL.sizeBytes,
              percent
            })
          }
        )

        // 下载 vad 文件 (30%)
        console.info('[VoiceTranscribe] 开始下载 VAD 文件...')
        await this.downloadToFile(
          (MODEL_DOWNLOAD_URLS as any).vad,
          vadPath,
          'vad',
          (downloaded, total) => {
            const modelSize = existsSync(modelPath) ? statSync(modelPath).size : 0
            const tokensSize = existsSync(tokensPath) ? statSync(tokensPath).size : 0
            const percent = total ? 70 + (downloaded / total) * 30 : 70
            onProgress?.({
              modelName: SENSEVOICE_MODEL.name,
              downloadedBytes: modelSize + tokensSize + downloaded,
              totalBytes: SENSEVOICE_MODEL.sizeBytes,
              percent
            })
          }
        )

        console.info('[VoiceTranscribe] 所有文件下载完成')
        return { success: true, modelPath, tokensPath }
      } catch (error) {
        const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
        const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)
        const vadPath = this.resolveModelPath((SENSEVOICE_MODEL.files as any).vad)
        try {
          if (existsSync(modelPath)) unlinkSync(modelPath)
          if (existsSync(tokensPath)) unlinkSync(tokensPath)
          if (existsSync(vadPath)) unlinkSync(vadPath)
        } catch { }
        return { success: false, error: String(error) }
      } finally {
        this.downloadTasks.delete(cacheKey)
      }
    })()

    this.downloadTasks.set(cacheKey, task)
    return task
  }

  /**
   * 转写 WAV 音频数据 (后台 Worker Threads 版本)
   */
  async transcribeWavBuffer(
    wavData: Buffer,
    onPartial?: (text: string) => void,
    languages?: string[]
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return new Promise((resolve) => {
      try {
        const modelPath = this.resolveModelPath(SENSEVOICE_MODEL.files.model)
        const tokensPath = this.resolveModelPath(SENSEVOICE_MODEL.files.tokens)

        if (!existsSync(modelPath) || !existsSync(tokensPath)) {
          resolve({ success: false, error: '模型文件不存在，请先下载模型' })
          return
        }

        // 获取配置的语言列表，如果没有传入则从配置读取
        let supportedLanguages = languages
        if (!supportedLanguages || supportedLanguages.length === 0) {
          supportedLanguages = this.configService.get('transcribeLanguages')
          // 如果配置中也没有或为空，使用默认值
          if (!supportedLanguages || supportedLanguages.length === 0) {
            supportedLanguages = ['zh']
          }
        }

        const { Worker } = require('worker_threads')
        // main.js 和 transcribeWorker.js 同在 dist-electron 目录下
        const workerPath = join(__dirname, 'transcribeWorker.js')

        const worker = new Worker(workerPath, {
          workerData: {
            modelPath,
            tokensPath,
            wavData,
            sampleRate: 16000,
            languages: supportedLanguages
          }
        })

        let finalTranscript = ''

        worker.on('message', (msg: any) => {
          if (msg.type === 'partial') {
            onPartial?.(msg.text)
          } else if (msg.type === 'final') {
            finalTranscript = msg.text
            resolve({ success: true, transcript: finalTranscript })
            worker.terminate()
          } else if (msg.type === 'error') {
            resolve({ success: false, error: msg.error })
            worker.terminate()
          }
        })

        worker.on('error', (err: Error) => {
          resolve({ success: false, error: String(err) })
        })

        worker.on('exit', (code: number) => {
          if (code !== 0) {
            console.error(`[VoiceTranscribe] Worker stopped with exit code ${code}`)
            resolve({ success: false, error: `Worker exited with code ${code}` })
          }
        })

      } catch (error) {
        resolve({ success: false, error: String(error) })
      }
    })
  }

  /**
   * 下载文件
   */
  private downloadToFile(
    url: string,
    targetPath: string,
    fileName: string,
    onProgress?: (downloaded: number, total?: number) => void,
    remainingRedirects = 5
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      console.info(`[VoiceTranscribe] 下载 ${fileName}:`, url)

      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 30000 // 30秒连接超时
      }

      const request = protocol.get(url, options, (response) => {
        console.info(`[VoiceTranscribe] ${fileName} 响应状态:`, response.statusCode)
        
        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
          if (remainingRedirects <= 0) {
            reject(new Error('重定向次数过多'))
            return
          }
          console.info(`[VoiceTranscribe] 重定向到:`, response.headers.location)
          this.downloadToFile(response.headers.location, targetPath, fileName, onProgress, remainingRedirects - 1)
            .then(resolve)
            .catch(reject)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${response.statusCode}`))
          return
        }

        const totalBytes = Number(response.headers['content-length'] || 0) || undefined
        let downloadedBytes = 0
        
        console.info(`[VoiceTranscribe] ${fileName} 文件大小:`, totalBytes ? `${(totalBytes / 1024 / 1024).toFixed(2)} MB` : '未知')

        const writer = createWriteStream(targetPath)
        
        // 设置数据接收超时（60秒没有数据则超时）
        let lastDataTime = Date.now()
        const dataTimeout = setInterval(() => {
          if (Date.now() - lastDataTime > 60000) {
            clearInterval(dataTimeout)
            response.destroy()
            writer.close()
            reject(new Error('下载超时：60秒内未收到数据'))
          }
        }, 5000)

        response.on('data', (chunk) => {
          lastDataTime = Date.now()
          downloadedBytes += chunk.length
          onProgress?.(downloadedBytes, totalBytes)
        })

        response.on('error', (error) => {
          clearInterval(dataTimeout)
          try { writer.close() } catch { }
          console.error(`[VoiceTranscribe] ${fileName} 响应错误:`, error)
          reject(error)
        })

        writer.on('error', (error) => {
          clearInterval(dataTimeout)
          try { writer.close() } catch { }
          console.error(`[VoiceTranscribe] ${fileName} 写入错误:`, error)
          reject(error)
        })

        writer.on('finish', () => {
          clearInterval(dataTimeout)
          writer.close()
          console.info(`[VoiceTranscribe] ${fileName} 下载完成:`, targetPath)
          resolve()
        })

        response.pipe(writer)
      })

      request.on('timeout', () => {
        request.destroy()
        console.error(`[VoiceTranscribe] ${fileName} 连接超时`)
        reject(new Error('连接超时'))
      })

      request.on('error', (error) => {
        console.error(`[VoiceTranscribe] ${fileName} 请求错误:`, error)
        reject(error)
      })
    })
  }

  /**
   * 清理资源
   */
  dispose() {
    if (this.recognizer) {
      try {
        // sherpa-onnx 的 recognizer 可能需要手动释放
        this.recognizer = null
      } catch (error) {
        }
    }
  }
}

export const voiceTranscribeService = new VoiceTranscribeService()

