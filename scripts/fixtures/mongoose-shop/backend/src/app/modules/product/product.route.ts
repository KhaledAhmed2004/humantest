import express from 'express';
import { ProductController } from './product.controller';

const router = express.Router();
router.post('/', ProductController.createProduct);
router.patch('/:id', ProductController.updateProduct);
router.post('/:id/sell', ProductController.sellProduct);
router.post('/:id/tags', ProductController.addTag);
router.patch('/:id/archive', ProductController.archiveProduct);
router.delete('/:id', ProductController.deleteProduct);
router.post('/:id/restock', ProductController.restockProduct);
export const ProductRoutes = router;
