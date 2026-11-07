import { Schema, model } from 'mongoose';

const productSchema = new Schema({ name: String, price: Number, stock: Number, status: String, tags: [String], archivedAt: Date });
export const Product = model('Product', productSchema);

const stockMoveSchema = new Schema({ product: Schema.Types.ObjectId, quantity: Number, reason: String });
export const StockMoveModel = model('StockMove', stockMoveSchema);
