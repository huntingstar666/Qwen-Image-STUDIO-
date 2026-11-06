/**
 * 作品画廊的精选数据。
 * 说明：这些条目整理自社区常见的开源提示词写法（Midjourney / Stable Diffusion 风格），
 * 用于给用户提供「可复刻」的起点；图片位置暂用分类渐变色卡占位，
 * 后续接入真实封面时只需给条目补 `image` 字段，页面无需改动。
 *
 * 字段：
 * - id / index：稳定标识与封面大号编号
 * - title / category：中文标题与分类
 * - prompt / negativePrompt：提示词（负向为空表示无需）
 * - seed：种子，null 表示该条目不提供（界面显示「—」）
 * - params：width / height / steps / cfg / sampler / scheduler
 * - palette：三色渐变，用于占位封面与收藏时的封面图
 * - style：一句话风格标签，便于快速浏览
 */

export const GALLERY_CATEGORIES = ['全部', '风景', '人像', '建筑', '产品', '插画', '概念'];

export const GALLERY_ITEMS = [
  {
    id: 'g01',
    index: '01',
    title: '晨雾湖畔',
    category: '风景',
    style: 'Cinematic · 电影感',
    prompt:
      'a serene alpine lake at dawn, low mist drifting over still water, snow-capped peaks mirrored on the surface, soft volumetric light, ultra detailed landscape photography, 35mm, f/8, natural color grading',
    negativePrompt: 'overexposed, harsh contrast, people, text, watermark',
    seed: 831204477,
    params: { width: 1536, height: 1024, steps: 32, cfg: 4.5, sampler: 'euler', scheduler: 'simple' },
    palette: ['#7fa8a0', '#3f6f6a', '#1d3b3a'],
  },
  {
    id: 'g02',
    index: '02',
    title: '雨夜霓虹',
    category: '风景',
    style: 'Cyberpunk · 霓虹',
    prompt:
      'rain-soaked Tokyo alley at night, neon signs reflecting in puddles, cinematic teal and magenta lighting, anamorphic lens flare, shallow depth of field, 35mm film still',
    negativePrompt: 'daylight, low contrast, blurry, cartoon',
    seed: 2065091834,
    params: { width: 1216, height: 1536, steps: 30, cfg: 5.0, sampler: 'dpmpp_2m', scheduler: 'karras' },
    palette: ['#3fd4c9', '#2b3f8f', '#151024'],
  },
  {
    id: 'g03',
    index: '03',
    title: '山间木屋',
    category: '风景',
    style: 'Minimal · 极简',
    prompt:
      'minimalist wooden cabin on a quiet green hillside, morning fog, warm window light, wide-angle composition, muted color palette, calm and spacious atmosphere',
    negativePrompt: '',
    seed: null,
    params: { width: 1344, height: 896, steps: 28, cfg: 4.0, sampler: 'euler', scheduler: 'simple' },
    palette: ['#c8d6b9', '#7f9a72', '#3c4d3a'],
  },
  {
    id: 'g04',
    index: '04',
    title: '沙漠孤旅',
    category: '风景',
    style: 'Fine Art · 留白',
    prompt:
      'lone traveler walking across rippled sand dunes, long shadows at golden hour, vast negative space, fine art photography, warm sand tones, 70-200mm compression',
    negativePrompt: 'crowd, buildings, cold colors',
    seed: 44209715,
    params: { width: 1536, height: 1024, steps: 34, cfg: 4.5, sampler: 'dpmpp_2m', scheduler: 'simple' },
    palette: ['#e5c79a', '#c08a52', '#6b4226'],
  },
  {
    id: 'g05',
    index: '05',
    title: '柔光人像',
    category: '人像',
    style: 'Editorial · 自然肤质',
    prompt:
      'close-up portrait of a young woman with freckles, soft window light from the left, 85mm lens, natural skin texture, warm neutral background, editorial beauty photography, subtle film grain',
    negativePrompt: 'plastic skin, over-smoothing, heavy makeup, extra fingers',
    seed: 917553820,
    params: { width: 1024, height: 1536, steps: 36, cfg: 4.5, sampler: 'euler', scheduler: 'karras' },
    palette: ['#e8d5c4', '#b98f79', '#5d4037'],
  },
  {
    id: 'g06',
    index: '06',
    title: '胶片街头',
    category: '人像',
    style: 'Film · 柯达质感',
    prompt:
      'candid street portrait of an elderly craftsman, weathered hands, 1960s film grain, Kodak Portra 400, soft afternoon light, muted earthy tones, documentary framing',
    negativePrompt: 'modern clothing, neon, oversaturated',
    seed: 1258993307,
    params: { width: 1216, height: 1536, steps: 30, cfg: 4.0, sampler: 'dpmpp_2m', scheduler: 'simple' },
    palette: ['#d9bfa1', '#8c6b4f', '#33261e'],
  },
  {
    id: 'g07',
    index: '07',
    title: '黑白侧影',
    category: '人像',
    style: 'Monochrome · 硬光',
    prompt:
      'black and white profile portrait, dramatic side lighting, strong shadow gradient across the background, studio backdrop, medium format detail, minimal composition',
    negativePrompt: 'color, noise, cluttered background',
    seed: 6071125,
    params: { width: 1024, height: 1536, steps: 32, cfg: 5.0, sampler: 'euler', scheduler: 'karras' },
    palette: ['#d8d8d8', '#7a7a7a', '#141414'],
  },
  {
    id: 'g08',
    index: '08',
    title: '竹林国风',
    category: '人像',
    style: 'Ink Wash · 东方',
    prompt:
      'young woman in modern hanfu standing in a bamboo forest, ink-wash atmosphere, soft diffused light, elegant composition, cinematic still, subtle green and grey palette',
    negativePrompt: 'western architecture, harsh sunlight, neon',
    seed: 330118644,
    params: { width: 896, height: 1344, steps: 30, cfg: 4.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
    palette: ['#b9d0bd', '#5f8268', '#21362a'],
  },
  {
    id: 'g09',
    index: '09',
    title: '曲面玻璃',
    category: '建筑',
    style: 'Architecture · 对称',
    prompt:
      'abstract curved glass facade reflecting clouds, symmetrical composition, clean lines, minimal sky, cool blue tones, architectural photography, high resolution detail',
    negativePrompt: 'people, cars, clutter, text',
    seed: 770423188,
    params: { width: 1216, height: 1536, steps: 30, cfg: 4.5, sampler: 'euler', scheduler: 'simple' },
    palette: ['#cfe3f0', '#7ea8c4', '#2b4a63'],
  },
  {
    id: 'g10',
    index: '10',
    title: '混凝土教堂',
    category: '建筑',
    style: 'Brutalist · 光束',
    prompt:
      'brutalist concrete chapel interior, a single shaft of sunlight cutting through the space, long shadows, dust in the air, wide angle, monochrome mood',
    negativePrompt: 'colorful, ornate decoration, crowds',
    seed: 580291,
    params: { width: 1024, height: 1536, steps: 34, cfg: 4.0, sampler: 'dpmpp_2m', scheduler: 'simple' },
    palette: ['#cfcdc7', '#8a8880', '#2f2e2b'],
  },
  {
    id: 'g11',
    index: '11',
    title: '蓝调天际线',
    category: '建筑',
    style: 'Cityscape · 蓝调',
    prompt:
      'dense city skyline at blue hour, layered buildings, warm windows glowing, atmospheric haze, telephoto compression, rich blue and amber contrast',
    negativePrompt: 'daylight, empty streets, low detail',
    seed: 1930482275,
    params: { width: 1536, height: 1024, steps: 30, cfg: 5.0, sampler: 'euler', scheduler: 'karras' },
    palette: ['#f0b76a', '#4a6a96', '#131c2e'],
  },
  {
    id: 'g12',
    index: '12',
    title: '日式庭院',
    category: '建筑',
    style: 'Zen · 侘寂',
    prompt:
      'traditional Japanese courtyard with moss garden, stone lantern, maple leaves, soft morning light, tranquil minimalism, natural materials, wide composition',
    negativePrompt: 'modern furniture, people, bright colors',
    seed: 88014276,
    params: { width: 1344, height: 896, steps: 28, cfg: 4.0, sampler: 'dpmpp_2m', scheduler: 'simple' },
    palette: ['#d5d9c3', '#7d8c65', '#33402c'],
  },
  {
    id: 'g13',
    index: '13',
    title: '香水静物',
    category: '产品',
    style: 'Commercial · 硬光',
    prompt:
      'luxury glass perfume bottle on wet black stone, dramatic rim light, water droplets, deep dark background, commercial product photography, crisp reflections',
    negativePrompt: 'flat lighting, busy background, watermark',
    seed: 1648720903,
    params: { width: 1024, height: 1024, steps: 32, cfg: 5.5, sampler: 'euler', scheduler: 'karras' },
    palette: ['#d8c9a3', '#6d5a3a', '#0f0d0a'],
  },
  {
    id: 'g14',
    index: '14',
    title: '咖啡时光',
    category: '产品',
    style: 'Lifestyle · 暖调',
    prompt:
      'ceramic coffee cup on a linen tablecloth, steam rising, warm side light, shallow depth of field, cozy lifestyle photography, soft shadows, muted brown palette',
    negativePrompt: 'plastic, neon, cluttered table',
    seed: 45088912,
    params: { width: 1344, height: 896, steps: 28, cfg: 4.0, sampler: 'euler', scheduler: 'simple' },
    palette: ['#e6d3bd', '#b08968', '#4a3427'],
  },
  {
    id: 'g15',
    index: '15',
    title: '机械腕表',
    category: '产品',
    style: 'Macro · 精密',
    prompt:
      'macro shot of a mechanical watch movement, brass gears and blued screws, precise studio lighting, ultra sharp detail, dark brushed metal background',
    negativePrompt: 'blurry, plastic, low detail',
    seed: 99120334,
    params: { width: 1024, height: 1024, steps: 36, cfg: 5.0, sampler: 'dpmpp_2m', scheduler: 'karras' },
    palette: ['#d9b27c', '#8a6a3f', '#141110'],
  },
  {
    id: 'g16',
    index: '16',
    title: '球鞋广告',
    category: '产品',
    style: 'Campaign · 动感',
    prompt:
      'floating sneaker in mid air, bold color background, crisp studio lighting, motion particles, advertising campaign visual, sharp product edges',
    negativePrompt: 'feet, messy background, low contrast',
    seed: 22590167,
    params: { width: 1216, height: 1536, steps: 30, cfg: 5.0, sampler: 'euler', scheduler: 'simple' },
    palette: ['#ffd166', '#ef476f', '#2b2d42'],
  },
  {
    id: 'g17',
    index: '17',
    title: '纸艺森林',
    category: '插画',
    style: 'Paper Cut · 童趣',
    prompt:
      'paper-cut layered forest scene, soft pastel colors, depth and shadow between layers, whimsical storybook style, clean vector edges, warm light',
    negativePrompt: 'realistic photo, harsh shadows, text',
    seed: 70211845,
    params: { width: 1344, height: 896, steps: 28, cfg: 4.5, sampler: 'euler', scheduler: 'simple' },
    palette: ['#f7e3c3', '#a8c6a1', '#4c6b55'],
  },
  {
    id: 'g18',
    index: '18',
    title: '水彩小镇',
    category: '插画',
    style: 'Watercolor · 地中海',
    prompt:
      'loose watercolor painting of an Italian coastal town, warm terracotta roofs, bleeding pigments, visible paper texture, bright Mediterranean light',
    negativePrompt: 'digital photo, sharp lines, dark mood',
    seed: null,
    params: { width: 1536, height: 1024, steps: 30, cfg: 4.0, sampler: 'dpmpp_2m', scheduler: 'simple' },
    palette: ['#f3d9b1', '#e0a26a', '#5b7f9c'],
  },
  {
    id: 'g19',
    index: '19',
    title: '像素冒险',
    category: '插画',
    style: 'Pixel Art · 16bit',
    prompt:
      '16-bit pixel art scene of a small hero standing on a cliff, sunset gradient sky, retro game palette, crisp pixels, atmospheric depth, limited colors',
    negativePrompt: 'smooth gradients, 3d render, blurry',
    seed: 13371337,
    params: { width: 1024, height: 1024, steps: 26, cfg: 5.0, sampler: 'euler', scheduler: 'simple' },
    palette: ['#ffb703', '#fb8500', '#023047'],
  },
  {
    id: 'g20',
    index: '20',
    title: '浮世绘猫',
    category: '插画',
    style: 'Ukiyo-e · 和风',
    prompt:
      'ukiyo-e style cat stretching on a wooden porch, indigo and vermilion palette, bold outlines, washi paper texture, flat perspective, subtle woodblock grain',
    negativePrompt: 'photorealistic, 3d, modern objects',
    seed: 512043,
    params: { width: 1344, height: 896, steps: 30, cfg: 4.5, sampler: 'dpmpp_2m', scheduler: 'karras' },
    palette: ['#f2e2c4', '#c0392b', '#22344d'],
  },
  {
    id: 'g21',
    index: '21',
    title: '悬浮岛屿',
    category: '概念',
    style: 'Fantasy · 史诗',
    prompt:
      'floating island with a giant ancient tree, waterfalls falling into clouds, soft god rays, epic fantasy matte painting, high detail, grand scale',
    negativePrompt: 'modern city, text, low detail',
    seed: 4211902,
    params: { width: 1536, height: 1024, steps: 34, cfg: 4.5, sampler: 'euler', scheduler: 'karras' },
    palette: ['#cfe8d5', '#6aa38a', '#1f3d4a'],
  },
  {
    id: 'g22',
    index: '22',
    title: '赛博僧侣',
    category: '概念',
    style: 'Cyberpunk · 概念',
    prompt:
      'cyberpunk monk with glowing tattoos meditating in a ruined temple, neon haze, volumetric fog, dramatic rim light, cinematic concept art, intricate details',
    negativePrompt: 'daylight, clean environment, cartoon',
    seed: 884200173,
    params: { width: 896, height: 1344, steps: 32, cfg: 5.0, sampler: 'dpmpp_2m', scheduler: 'karras' },
    palette: ['#43e5c4', '#6b3fa0', '#0d0b1a'],
  },
  {
    id: 'g23',
    index: '23',
    title: '深海巨鲸',
    category: '概念',
    style: 'Underwater · 巨物',
    prompt:
      'enormous whale drifting through a sunlit underwater canyon, shafts of light piercing the deep blue, a tiny diver for scale, awe-inspiring concept art, volumetric water',
    negativePrompt: 'dark mud, low visibility, text',
    seed: 30951782,
    params: { width: 1536, height: 1024, steps: 34, cfg: 4.5, sampler: 'euler', scheduler: 'simple' },
    palette: ['#9fe3e8', '#2b7a9b', '#061a2b'],
  },
  {
    id: 'g24',
    index: '24',
    title: '未来交通',
    category: '概念',
    style: 'Solarpunk · 未来',
    prompt:
      'sleek autonomous pod gliding through a solar-punk city, lush vertical gardens, clean futuristic design, soft morning light, optimistic atmosphere, wide angle',
    negativePrompt: 'pollution, dystopia, dirty streets',
    seed: null,
    params: { width: 1536, height: 1024, steps: 30, cfg: 4.0, sampler: 'dpmpp_2m', scheduler: 'simple' },
    palette: ['#dff0c8', '#79b06a', '#244f5c'],
  },
];
