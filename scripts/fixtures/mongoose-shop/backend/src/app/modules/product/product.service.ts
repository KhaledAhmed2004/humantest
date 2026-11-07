import mongoose from 'mongoose';
import { Product, StockMoveModel } from './product.model';

class AppError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }

const createProduct = async (payload: { name: string; price: number }) => {
  return Product.create({ ...payload, status: 'DRAFT', stock: 0 });
};

const updateProduct = async (id: string, payload: { name?: string; price?: number }) => {
  const product = await Product.findById(id);
  if (!product) throw new AppError(404, 'Product not found');
  Object.assign(product, payload);
  await product.save();
  return product;
};

const sellProduct = async (id: string, quantity: number) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const product = await Product.findById(id).session(session);
      if (!product) throw new AppError(404, 'Product not found');
      if ((product.stock ?? 0) < quantity) throw new AppError(400, 'Not enough stock');
      await Product.updateOne({ _id: id }, { $inc: { stock: -quantity } }, { session });
      await StockMoveModel.create([{ product: id, quantity, reason: 'SALE' }], { session });
    });
  } finally {
    await session.endSession();
  }
};

const addTag = async (id: string, tag: string) => {
  await Product.findByIdAndUpdate(id, { $addToSet: { tags: tag } });
};

const archiveProduct = async (id: string) => {
  const product = await Product.findById(id).select('status');
  if (!product) throw new AppError(404, 'Product not found');
  product.status = 'ARCHIVED';
  product.archivedAt = new Date();
  await product.save();
};

const deleteProduct = async (id: string) => {
  await Product.findByIdAndDelete(id);
  await StockMoveModel.deleteMany({ product: id });
};

const restockProduct = async (id: string, quantity: number) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await Product.findByIdAndUpdate(id, { $inc: { stock: quantity }, $set: { status: 'ACTIVE' } }, { session });
    const move = new StockMoveModel({ product: id, quantity, reason: 'RESTOCK' });
    await move.save({ session });
    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};

export const ProductService = { createProduct, updateProduct, sellProduct, addTag, archiveProduct, deleteProduct, restockProduct };
