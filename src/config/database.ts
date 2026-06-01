import mongoose from 'mongoose';

let connectionPromise: Promise<void> | null = null;

export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState >= 1) return;

  if (!connectionPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');

    connectionPromise = mongoose
      .connect(uri, { serverSelectionTimeoutMS: 10000 })
      .then(() => { console.log('MongoDB connected'); })
      .catch((err) => { connectionPromise = null; throw err; });
  }

  return connectionPromise;
}

export async function disconnectDatabase(): Promise<void> {
  connectionPromise = null;
  await mongoose.disconnect();
}
