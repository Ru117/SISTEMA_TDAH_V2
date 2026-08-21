import * as ort from 'onnxruntime-node';

// Cargar modelo
export const session = await ort.InferenceSession.create('./weights/onnx/modelo_tdah.onnx');
