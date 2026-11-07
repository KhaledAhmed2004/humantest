import express from 'express';
import { ProductRoutes } from './app/modules/product/product.route';

const app = express();
app.use(express.json());
app.use('/api/v1/products', ProductRoutes);
export default app;
