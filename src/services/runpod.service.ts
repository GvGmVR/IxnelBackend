import axios from 'axios';
import { env } from '../../Todelete/config/env';

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;

const runpodClient = axios.create({
  baseURL: `https://api.runpod.ai/v1/${ENDPOINT_ID}`,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${RUNPOD_API_KEY}`,
  },
});

export const runpodService = {
  /**
   * Starts an asynchronous job on RunPod.
   * Returns immediately with the job ID.
   */
  startAsyncJob: async (input: any) => {
    try {
      if (!RUNPOD_API_KEY || !ENDPOINT_ID) {
        throw new Error('RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID is not configured');
      }

      const response = await runpodClient.post('/run', { input });
      return response.data; // { id: string, status: string }
    } catch (error: any) {
      console.error('RunPod startAsyncJob error:', error.response?.data || error.message);
      throw error;
    }
  },

  /**
   * Checks the status of a specific job on RunPod.
   */
  getJobStatus: async (jobId: string) => {
    try {
      const response = await runpodClient.get(`/status/${jobId}`);
      return response.data; // { id: string, status: string, output?: any, error?: string }
    } catch (error: any) {
      console.error('RunPod getJobStatus error:', error.response?.data || error.message);
      throw error;
    }
  },

  /**
   * Cancels a job on RunPod.
   */
  cancelJob: async (jobId: string) => {
    try {
      const response = await runpodClient.post(`/cancel/${jobId}`);
      return response.data;
    } catch (error: any) {
      console.error('RunPod cancelJob error:', error.response?.data || error.message);
      throw error;
    }
  }
};
