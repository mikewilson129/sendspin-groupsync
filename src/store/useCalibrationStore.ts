import { create } from 'zustand';
import type { CalibrationPhase } from '../types';

interface CalibrationState {
  phase: CalibrationPhase;
  setPhase: (phase: CalibrationPhase) => void;
}

export const useCalibrationStore = create<CalibrationState>()((set) => ({
  phase: 'idle',
  setPhase: (phase) => set({ phase }),
}));
