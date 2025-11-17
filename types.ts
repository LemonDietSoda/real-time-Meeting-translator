
export enum AppStatus {
    IDLE = 'Idle',
    CONNECTING = 'Connecting...',
    LISTENING = 'Listening',
    ERROR = 'Error'
}

export interface TranscriptionTurn {
    id: number;
    chinese: string;
    english: string;
}
