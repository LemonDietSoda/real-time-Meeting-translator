import React, { useState, useRef, useCallback, useEffect } from 'react';
// Fix: Removed 'LiveSession' as it is not an exported member of '@google/genai'.
import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';
import { AppStatus, TranscriptionTurn } from './types';
import { createPcmBlob, decode, decodeAudioData } from './utils/audio';

// Fix: Per coding guidelines, the API key must be sourced from process.env.API_KEY.
// This change removes the dependency on Vite's import.meta.env and the associated UI for key management,
// which also resolves the TypeScript error "Property 'env' does not exist on type 'ImportMeta'".

// --- UI Components ---

const MicrophoneIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
    </svg>
);

const StopIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 6h12v12H6z"/>
    </svg>
);

interface TranscriptionDisplayProps {
    history: TranscriptionTurn[];
    currentChinese: string;
    currentEnglish: string;
}

const TranscriptionDisplay: React.FC<TranscriptionDisplayProps> = ({ history, currentChinese, currentEnglish }) => {
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [history, currentChinese, currentEnglish]);

    return (
        <div ref={scrollRef} className="flex-grow w-full max-w-4xl p-4 md:p-6 space-y-6 overflow-y-auto">
            {history.map(turn => (
                <div key={turn.id} className="p-4 rounded-lg bg-white bg-opacity-5 border border-gray-700">
                    <p className="text-lg text-gray-300 font-light">{turn.chinese}</p>
                    <p className="text-xl text-white font-medium mt-2">{turn.english}</p>
                </div>
            ))}
            {(currentChinese || currentEnglish) && (
                <div className="p-4 rounded-lg bg-blue-500 bg-opacity-10 border border-blue-400">
                    <p className="text-lg text-gray-200 font-light">{currentChinese}</p>
                    <p className="text-xl text-blue-300 font-medium mt-2">{currentEnglish}</p>
                </div>
            )}
        </div>
    );
};


// --- Main Application Component ---

export default function App() {
    const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
    const [transcriptionHistory, setTranscriptionHistory] = useState<TranscriptionTurn[]>([]);
    const [currentChinese, setCurrentChinese] = useState('');
    const [currentEnglish, setCurrentEnglish] = useState('');

    // Fix: Using `any` for the session promise ref as the `LiveSession` type is not exported.
    const sessionPromiseRef = useRef<any | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const nextStartTimeRef = useRef(0);
    const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

    const currentChineseRef = useRef('');
    const currentEnglishRef = useRef('');

    const cleanUpAudio = useCallback(() => {
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;

        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current.onaudioprocess = null;
            processorRef.current = null;
        }

        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close().catch(console.error);
        }
        audioContextRef.current = null;

        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
            outputAudioContextRef.current.close().catch(console.error);
        }
        outputAudioContextRef.current = null;
        audioSourcesRef.current.forEach(source => source.stop());
        audioSourcesRef.current.clear();
        nextStartTimeRef.current = 0;

    }, []);

    const handleStopListening = useCallback(async () => {
        if (sessionPromiseRef.current) {
            try {
                const session = await sessionPromiseRef.current;
                session.close();
            } catch (error) {
                console.error("Error closing session:", error);
            } finally {
                sessionPromiseRef.current = null;
            }
        }
        cleanUpAudio();
        setStatus(AppStatus.IDLE);
    }, [cleanUpAudio]);


    const handleStartListening = useCallback(async () => {
        setStatus(AppStatus.CONNECTING);
        setCurrentChinese('');
        setCurrentEnglish('');
        currentChineseRef.current = '';
        currentEnglishRef.current = '';
        setTranscriptionHistory([]);

        try {
            // Fix: API key check removed. Per guidelines, the API key is assumed to be available via process.env.API_KEY.

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            // Fix: Initialize GoogleGenAI with process.env.API_KEY per coding guidelines.
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

            sessionPromiseRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    systemInstruction: 'You are a real-time translator. The user is speaking in Traditional Chinese. Listen to their speech and respond by speaking the English translation clearly and immediately. Do not add any conversational filler, just the direct translation.',
                },
                callbacks: {
                    onopen: () => {
                        setStatus(AppStatus.LISTENING);
                        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
                        const source = audioContextRef.current.createMediaStreamSource(stream);
                        processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
                        
                        processorRef.current.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob = createPcmBlob(inputData);
                            sessionPromiseRef.current?.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };
                        
                        source.connect(processorRef.current);
                        processorRef.current.connect(audioContextRef.current.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        if (message.serverContent?.inputTranscription) {
                            const text = message.serverContent.inputTranscription.text;
                            setCurrentChinese(prev => prev + text);
                            currentChineseRef.current += text;
                        }

                        if (message.serverContent?.outputTranscription) {
                            const text = message.serverContent.outputTranscription.text;
                            setCurrentEnglish(prev => prev + text);
                            currentEnglishRef.current += text;
                        }

                        const base64EncodedAudioString = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64EncodedAudioString && outputAudioContextRef.current) {
                            const outputAudioContext = outputAudioContextRef.current;
                            const nextStartTime = Math.max(
                                nextStartTimeRef.current,
                                outputAudioContext.currentTime
                            );
                            const audioBuffer = await decodeAudioData(
                                decode(base64EncodedAudioString),
                                outputAudioContext,
                                24000,
                                1
                            );
                            const source = outputAudioContext.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputAudioContext.destination);
                            const sources = audioSourcesRef.current;
                            source.addEventListener('ended', () => {
                                sources.delete(source);
                            });

                            source.start(nextStartTime);
                            nextStartTimeRef.current = nextStartTime + audioBuffer.duration;
                            sources.add(source);
                        }

                        if (message.serverContent?.interrupted) {
                            audioSourcesRef.current.forEach(source => source.stop());
                            audioSourcesRef.current.clear();
                            nextStartTimeRef.current = 0;
                        }
                        
                        if (message.serverContent?.turnComplete) {
                            const finalChinese = currentChineseRef.current;
                            const finalEnglish = currentEnglishRef.current;
                            
                            if (finalChinese.trim() || finalEnglish.trim()) {
                                setTranscriptionHistory(prev => [...prev, { id: Date.now(), chinese: finalChinese, english: finalEnglish }]);
                            }

                            setCurrentChinese('');
                            setCurrentEnglish('');
                            currentChineseRef.current = '';
                            currentEnglishRef.current = '';
                        }
                    },
                    // Fix: Corrected the type of the error parameter to ErrorEvent for the onerror callback.
                    onerror: (e: ErrorEvent) => {
                        console.error("An unexpected error occurred:", e);
                        setStatus(AppStatus.ERROR);
                        setCurrentEnglish(`Error: ${e.message}`);
                        handleStopListening();
                    },
                    onclose: () => {
                        console.log("Connection closed.");
                        setStatus(currentStatus => currentStatus === AppStatus.ERROR ? AppStatus.ERROR : AppStatus.IDLE);
                        cleanUpAudio();
                    },
                },
            });
        } catch (error) {
            console.error("Failed to start listening:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            setStatus(AppStatus.ERROR);
            setCurrentEnglish(`Error: ${errorMessage}`);
            cleanUpAudio();
        }
    }, [cleanUpAudio, handleStopListening]);

    // Fix: Removed conditional rendering for API key availability.
    // Per guidelines, the app should assume the API key is always configured correctly.
    return (
        <div className="flex flex-col h-screen items-center justify-between p-4 md:p-8 bg-gray-900 text-white">
            <header className="w-full max-w-4xl">
                <h1 className="text-3xl md:text-4xl font-bold text-center">Real-time Meeting Translator</h1>
                <p className="text-center text-gray-400 mt-2">Traditional Chinese to English Subtitles</p>
            </header>
            
            <TranscriptionDisplay 
                history={transcriptionHistory} 
                currentChinese={currentChinese} 
                currentEnglish={currentEnglish} 
            />

            <footer className="w-full max-w-4xl flex flex-col items-center">
                <div className="flex items-center space-x-4">
                    <button
                        onClick={status === AppStatus.LISTENING || status === AppStatus.CONNECTING ? handleStopListening : handleStartListening}
                        disabled={status === AppStatus.CONNECTING}
                        className={`px-6 py-4 rounded-full flex items-center justify-center transition-all duration-300 ease-in-out focus:outline-none focus:ring-4 focus:ring-opacity-50
                            ${status === AppStatus.LISTENING || status === AppStatus.CONNECTING ? 'bg-red-600 hover:bg-red-700 focus:ring-red-400' : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-400'}
                            ${status === AppStatus.CONNECTING ? 'opacity-50 cursor-wait' : ''}
                        `}
                        aria-label={status === AppStatus.LISTENING || status === AppStatus.CONNECTING ? 'Stop Listening' : 'Start Listening'}
                    >
                        {status === AppStatus.LISTENING || status === AppStatus.CONNECTING ? <StopIcon /> : <MicrophoneIcon />}
                    </button>
                    <p className={`text-lg w-32 text-left ${status === AppStatus.LISTENING ? 'text-red-400 animate-pulse-opacity' : 'text-gray-300'}`}>
                        {status}
                    </p>
                </div>
                {status === AppStatus.ERROR && <p className="text-red-400 mt-4">An error occurred. Please check the transcript for details and try again.</p>}
            </footer>
        </div>
    );
}
