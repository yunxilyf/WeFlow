import { parentPort, workerData } from 'worker_threads'
import * as fs from 'fs'

interface WorkerParams {
    modelPath: string
    tokensPath: string
    wavData: Buffer
    sampleRate: number
    languages?: string[]
}

// 语言标记映射
const LANGUAGE_TAGS: Record<string, string> = {
    'zh': '<|zh|>',
    'en': '<|en|>',
    'ja': '<|ja|>',
    'ko': '<|ko|>',
    'yue': '<|yue|>' // 粤语
}

// 检查识别结果是否在允许的语言列表中
function isLanguageAllowed(result: any, allowedLanguages: string[]): boolean {
    if (!result || !result.lang) {
        // 如果没有语言信息，默认允许
        return true
    }

    // 如果没有指定语言或语言列表为空，默认只允许中文
    if (!allowedLanguages || allowedLanguages.length === 0) {
        allowedLanguages = ['zh']
    }

    const langTag = result.lang
    console.log('[TranscribeWorker] 检测到语言标记:', langTag)

    // 检查是否在允许的语言列表中
    for (const lang of allowedLanguages) {
        if (LANGUAGE_TAGS[lang] === langTag) {
            console.log('[TranscribeWorker] 语言匹配，允许:', lang)
            return true
        }
    }

    console.log('[TranscribeWorker] 语言不在白名单中，过滤掉')
    return false
}

async function run() {
    if (!parentPort) {
        return;
    }

    try {
        // 动态加载以捕获可能的加载错误（如 C++ 运行库缺失等）
        let sherpa: any;
        try {
            sherpa = require('sherpa-onnx-node');
            } catch (requireError) {
            parentPort.postMessage({ type: 'error', error: 'Failed to load speech engine: ' + String(requireError) });
            return;
        }

        const { modelPath, tokensPath, wavData: rawWavData, sampleRate, languages } = workerData as WorkerParams
        const wavData = Buffer.from(rawWavData);
        // 确保有有效的语言列表，默认只允许中文
        let allowedLanguages = languages || ['zh']
        if (allowedLanguages.length === 0) {
          allowedLanguages = ['zh']
        }
        
        console.log('[TranscribeWorker] 使用的语言白名单:', allowedLanguages)
        
        // 1. 初始化识别器 (SenseVoiceSmall)
        const recognizerConfig = {
            modelConfig: {
                senseVoice: {
                    model: modelPath,
                    useInverseTextNormalization: 1
                },
                tokens: tokensPath,
                numThreads: 2,
                debug: 0
            }
        }
        const recognizer = new sherpa.OfflineRecognizer(recognizerConfig)
        // 2. 初始化 VAD (用于流式输出效果)
        const vadPath = modelPath.replace('model.int8.onnx', 'silero_vad.onnx');
        const vadConfig = {
            sileroVad: {
                model: vadPath,
                threshold: 0.5,
                minSilenceDuration: 0.5,
                minSpeechDuration: 0.25,
                windowSize: 512
            },
            sampleRate: sampleRate,
            debug: 0,
            numThreads: 1
        }

        // 检查 VAD 模型是否存在，如果不存在则退回到全量识别
        if (!fs.existsSync(vadPath)) {
            const pcmData = wavData.slice(44)
            const samples = new Float32Array(pcmData.length / 2)
            for (let i = 0; i < samples.length; i++) {
                samples[i] = pcmData.readInt16LE(i * 2) / 32768.0
            }

            const stream = recognizer.createStream()
            stream.acceptWaveform({ sampleRate, samples })
            recognizer.decode(stream)
            const result = recognizer.getResult(stream)

            console.log('[TranscribeWorker] 非VAD模式 - 识别结果对象:', JSON.stringify(result, null, 2))
            
            // 检查语言是否在白名单中
            if (isLanguageAllowed(result, allowedLanguages)) {
                console.log('[TranscribeWorker] 非VAD模式 - 保留文本:', result.text)
                parentPort.postMessage({ type: 'final', text: result.text })
            } else {
                console.log('[TranscribeWorker] 非VAD模式 - 语言不匹配，返回空文本')
                parentPort.postMessage({ type: 'final', text: '' })
            }
            return
        }

        const vad = new sherpa.Vad(vadConfig, 60) // 60s max
        // 3. 处理音频数据
        const pcmData = wavData.slice(44)
        const samples = new Float32Array(pcmData.length / 2)
        for (let i = 0; i < samples.length; i++) {
            samples[i] = pcmData.readInt16LE(i * 2) / 32768.0
        }

        // 模拟流式输入：按小块喂给 VAD
        const chunkSize = 1600 // 100ms for 16kHz
        let offset = 0
        let accumulatedText = ''

        let segmentCount = 0;

        while (offset < samples.length) {
            const end = Math.min(offset + chunkSize, samples.length)
            const chunk = samples.subarray(offset, end)

            vad.acceptWaveform(chunk)

            // 检查 ASR 结果
            while (!vad.isEmpty()) {
                const segment = vad.front(false)

                const stream = recognizer.createStream()
                stream.acceptWaveform({ sampleRate, samples: segment.samples })
                recognizer.decode(stream)
                const result = recognizer.getResult(stream)

                console.log('[TranscribeWorker] 识别结果 - lang:', result.lang, 'text:', result.text)
                
                // 检查语言是否在白名单中
                if (result.text && isLanguageAllowed(result, allowedLanguages)) {
                    const text = result.text.trim()
                    if (text.length > 0) {
                        accumulatedText += (accumulatedText ? ' ' : '') + text
                        segmentCount++;
                        parentPort.postMessage({ type: 'partial', text: accumulatedText })
                    }
                } else if (result.text) {
                    console.log('[TranscribeWorker] 跳过不匹配的语言段落')
                }
                vad.pop()
            }

            offset = end
            // 让出主循环，保持响应
            await new Promise(resolve => setImmediate(resolve))
        }

        // Ensure any remaining buffer is processed
        vad.flush();
        while (!vad.isEmpty()) {
            const segment = vad.front(false);
            const stream = recognizer.createStream()
            stream.acceptWaveform({ sampleRate, samples: segment.samples })
            recognizer.decode(stream)
            const result = recognizer.getResult(stream)
            
            console.log('[TranscribeWorker] flush阶段 - lang:', result.lang, 'text:', result.text)
            
            // 检查语言是否在白名单中
            if (result.text && isLanguageAllowed(result, allowedLanguages)) {
                const text = result.text.trim()
                if (text) {
                    accumulatedText += (accumulatedText ? ' ' : '') + text
                    parentPort.postMessage({ type: 'partial', text: accumulatedText })
                }
            }
            vad.pop();
        }

        parentPort.postMessage({ type: 'final', text: accumulatedText })

    } catch (error) {
        parentPort.postMessage({ type: 'error', error: String(error) })
    }
}

run();

