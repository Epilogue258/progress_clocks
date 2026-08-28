package com.progressclocks.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                Surface {
                    ProgressClocksApp()
                }
            }
        }
    }
}

@Composable
fun ProgressClocksApp() {
    // TODO(设计确认后实现)
    // - 进度钟网格：点击 +1 / 长按菜单（+2/+3/清零/改名/删除）
    // - 撤销/重做（快照栈），顶栏按钮
    // - 新建：底部 FAB
    // - 本地持久化：状态 JSON -> 内部存储；变更事件模型为同步预留
    // - 数据模型与 Web/src/types.ts 保持同一契约（camelCase）
}
