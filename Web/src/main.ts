/**
 * 进度钟 Web 端入口（骨架阶段，业务逻辑待设计分析后实现）
 *
 * 规划：
 * - 画钟渲染（Canvas：任意等分圆环、填充动画）
 * - GM 主控模式（编辑：点击填充/长按菜单、快捷键 Ctrl+Z/Ctrl+Y/Ctrl+N）
 * - 玩家查看模式（只读、大字号）
 * - 轮询同步（api.ts）
 */
import './styles.css'

const app = document.getElementById('app')!
app.textContent = '进度钟（骨架）'
