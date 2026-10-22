import { z } from 'zod'

export const RatingValue = z.number().min(0.5).max(5).multipleOf(0.5)
